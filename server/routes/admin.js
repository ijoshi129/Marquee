const express = require('express');
const { spawn } = require('node:child_process');
const { Readable } = require('node:stream');
const zlib = require('node:zlib');
const logger = require('../logger');
const { pool } = require('../db');
const { simpleParser } = require('mailparser');
const { classify } = require('../services/email-classify');
const reservationParser = require('../parsers/amc-reservation');
const thankyouParser = require('../parsers/amc-thankyou');
const cancellationParser = require('../parsers/amc-cancellation');
const matcher = require('../services/matcher');
const poller = require('../workers/email-poller');

const router = express.Router();

const IMPORT_LIMIT = process.env.DATABASE_IMPORT_LIMIT || '200mb';

function requireAdminToken(req, res, next) {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return next();

  const auth = req.get('authorization') || '';
  const bearer = auth.match(/^Bearer\s+(.+)$/i)?.[1];
  const supplied = bearer || req.get('x-admin-token');
  if (supplied === token) return next();
  return res.status(401).json({ error: 'Admin token required' });
}

// List email_log rows. Filter ?status=failed|ok|pending and ?type=reservation|thankyou|unknown.
router.get('/email-log', async (req, res) => {
  try {
    const params = [];
    const where = [];
    if (req.query.status) {
      params.push(req.query.status);
      where.push(`parse_status = $${params.length}`);
    }
    if (req.query.type) {
      params.push(req.query.type);
      where.push(`type = $${params.length}`);
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const sql = `
      SELECT gmail_message_id, type, received_at, parsed_at, parse_status, parse_error, watch_id
      FROM email_log
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY received_at DESC
      LIMIT ${limit}`;
    const rows = (await pool.query(sql, params)).rows;
    res.json(rows);
  } catch (err) {
    logger.error({ err: err }, 'email-log list');
    res.status(500).json({ error: 'Server error' });
  }
});

// Get a single email_log row WITH raw_html (heavy — for one-at-a-time inspection).
router.get('/email-log/:id', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM email_log WHERE gmail_message_id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(r.rows[0]);
  } catch (err) {
    logger.error({ err: err }, 'email-log get');
    res.status(500).json({ error: 'Server error' });
  }
});

// Re-run the parser on a stored raw_html. If parse succeeds, dispatches to matcher.
router.post('/email-log/:id/reparse', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM email_log WHERE gmail_message_id = $1`,
      [req.params.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const row = r.rows[0];
    const mail = await simpleParser(row.raw_html);
    const subject = mail.subject || '';
    const type = classify(subject);
    const html = mail.html || mail.textAsHtml || '';
    const text = mail.text || '';

    let parsed = null;
    if (type === 'reservation') parsed = reservationParser.parse({ subject, html, text });
    else if (type === 'thankyou') parsed = thankyouParser.parse({ subject, html, text });
    else if (type === 'cancellation') parsed = cancellationParser.parse({ subject, html, text });
    else parsed = { ok: true, fields: null, error: null };

    if (!parsed.ok) {
      await pool.query(
        `UPDATE email_log SET type=$1, parse_status='failed', parse_error=$2, parsed_at=NOW()
         WHERE gmail_message_id=$3`,
        [type, parsed.error, row.gmail_message_id]
      );
      return res.json({ type, ok: false, error: parsed.error });
    }

    let dispatch = null;
    if (type === 'reservation' && parsed.fields) {
      dispatch = await matcher.ingestReservation({
        fields: parsed.fields,
        gmail_message_id: row.gmail_message_id,
      });
    } else if (type === 'thankyou' && parsed.fields) {
      dispatch = await matcher.ingestThankyou({
        fields: parsed.fields,
        gmail_message_id: row.gmail_message_id,
        received_at: row.received_at,
      });
    } else if (type === 'cancellation' && parsed.fields) {
      dispatch = await matcher.ingestCancellation({
        fields: parsed.fields,
        gmail_message_id: row.gmail_message_id,
      });
    }

    await pool.query(
      `UPDATE email_log SET type=$1, parse_status='ok', parse_error=NULL, parsed_at=NOW(), watch_id=$2
       WHERE gmail_message_id=$3`,
      [type, dispatch?.watch_id || null, row.gmail_message_id]
    );

    res.json({ type, ok: true, fields: parsed.fields, dispatch });
  } catch (err) {
    logger.error({ err: err }, 'reparse');
    res.status(500).json({ error: err.message });
  }
});

// Force a poller run now (useful for testing).
router.post('/poll-now', async (req, res) => {
  try {
    await poller.pollOnce();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/database/export — stream a restorable Postgres SQL dump.
// The dump is gzipped and includes DROP statements, so importing it into a
// non-empty Marquee database replaces the app tables with the backup contents.
router.get('/database/export', requireAdminToken, async (req, res) => {
  const filename = `marquee-db-${new Date().toISOString().slice(0, 10)}.sql.gz`;
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

  const dump = spawn(
    'pg_dump',
    [
      '--no-owner',
      '--no-privileges',
      '--clean',
      '--if-exists',
      process.env.DATABASE_URL,
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );
  const gzip = zlib.createGzip({ level: 9 });

  let dumpErr = '';
  dump.stderr.on('data', (chunk) => {
    dumpErr += chunk.toString();
  });
  dump.on('error', (err) => {
    logger.error({ err }, 'database export spawn failed');
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy(err);
  });
  dump.on('close', (code) => {
    if (code !== 0) {
      const err = new Error(`pg_dump exit ${code}: ${dumpErr.trim()}`);
      logger.error({ err }, 'database export failed');
      if (!res.headersSent) res.status(500).json({ error: err.message });
      else res.destroy(err);
    }
  });
  gzip.on('error', (err) => {
    logger.error({ err }, 'database export gzip failed');
    res.destroy(err);
  });
  req.on('close', () => {
    if (!res.writableEnded) dump.kill('SIGTERM');
  });

  dump.stdout.pipe(gzip).pipe(res);
});

// POST /api/admin/database/import — restore a dump produced by the export API
// or daily backup worker. Send the file body as application/gzip (or
// application/octet-stream for either gzipped or plain SQL).
router.post(
  '/database/import',
  requireAdminToken,
  express.raw({
    type: [
      'application/gzip',
      'application/x-gzip',
      'application/octet-stream',
      'application/sql',
      'text/plain',
    ],
    limit: IMPORT_LIMIT,
  }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: 'SQL dump body is required' });
      }

      const isGzip = req.body[0] === 0x1f && req.body[1] === 0x8b;
      const sql = isGzip ? zlib.gunzipSync(req.body) : req.body;
      if (
        !/PostgreSQL database dump|CREATE TABLE|COPY .* FROM stdin|INSERT INTO|DROP TABLE/i.test(
          sql.toString('utf8', 0, 65536)
        )
      ) {
        return res.status(400).json({ error: 'Body does not look like a SQL dump' });
      }

      const psql = spawn(
        'psql',
        ['--set', 'ON_ERROR_STOP=1', '--quiet', process.env.DATABASE_URL],
        { stdio: ['pipe', 'ignore', 'pipe'] }
      );

      let stderr = '';
      psql.stderr.on('data', (chunk) => {
        stderr += chunk.toString();
      });
      const restore = new Promise((resolve, reject) => {
        psql.on('error', reject);
        psql.on('close', (code) => {
          if (code !== 0) {
            reject(new Error(`psql exit ${code}: ${stderr.trim()}`));
          } else {
            resolve();
          }
        });
      });
      Readable.from(sql).pipe(psql.stdin);
      await restore;

      logger.info({ bytes: req.body.length, gzipped: isGzip }, 'database import completed');
      res.json({ ok: true, bytes: req.body.length, gzipped: isGzip });
    } catch (err) {
      logger.error({ err }, 'database import failed');
      res.status(500).json({ error: err.message });
    }
  }
);

module.exports = router;
