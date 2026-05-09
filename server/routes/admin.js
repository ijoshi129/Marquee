const express = require('express');
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

module.exports = router;
