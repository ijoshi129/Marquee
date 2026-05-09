// Poller: every 5 min, fetch new AMC messages, persist to email_log, then process pending rows.
//
// Two phases for crash safety:
//   1. ingest:  IMAP fetch → INSERT email_log (parse_status='pending') ON CONFLICT DO NOTHING
//   2. process: SELECT pending rows → classify → parse → dispatch → UPDATE parse_status
//
// Either phase can crash and be safely re-run.

const { simpleParser } = require('mailparser');
const logger = require('../logger');
const cron = require('node-cron');

const { pool } = require('../db');
const { fetchAmcMessages } = require('../services/imap');
const { classify } = require('../services/email-classify');
const reservationParser = require('../parsers/amc-reservation');
const thankyouParser = require('../parsers/amc-thankyou');
const cancellationParser = require('../parsers/amc-cancellation');
const matcher = require('../services/matcher');
const pendingExpirer = require('./pending-expirer');

async function ingestPhase() {
  // For backfill / catch-up, look back 90 days the first time, then since the latest
  // email_log row's received_at - 1 day on subsequent runs.
  const last = await pool.query(
    'SELECT MAX(received_at) AS max_received FROM email_log'
  );
  const maxRecv = last.rows[0].max_received;
  const since = maxRecv
    ? new Date(new Date(maxRecv).getTime() - 24 * 3600_000)
    : null; // null = backfill all

  const messages = await fetchAmcMessages({ since });
  let newCount = 0;
  for (const m of messages) {
    const ins = await pool.query(
      `INSERT INTO email_log (gmail_message_id, type, received_at, raw_html, parse_status)
       VALUES ($1, 'unknown', $2, $3, 'pending')
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING gmail_message_id`,
      [m.gmail_message_id, m.received_at, (m.source || '').toString('utf8')]
    );
    if (ins.rows.length) newCount++;
  }
  return { fetched: messages.length, newCount };
}

const MAX_PARSE_ATTEMPTS = 5;

async function processPhase() {
  // Skip rows past the retry limit — they'll stay 'failed' (dead-letter)
  // and surface in /api/admin/email-log?status=failed.
  const pending = await pool.query(
    `SELECT gmail_message_id, received_at, raw_html, parse_attempts
     FROM email_log
     WHERE parse_status = 'pending'
       AND parse_attempts < $1
     ORDER BY received_at ASC
     LIMIT 200`,
    [MAX_PARSE_ATTEMPTS]
  );

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  const failures = [];

  for (const row of pending.rows) {
    const { gmail_message_id, received_at, raw_html } = row;
    try {
      const mail = await simpleParser(raw_html);
      const subject = mail.subject || '';
      const type = classify(subject);
      const html = mail.html || mail.textAsHtml || '';
      const text = mail.text || '';

      if (type === 'unknown') {
        await markStatus(gmail_message_id, type, 'ok', null, null);
        skipped++;
        continue;
      }

      const parsed =
        type === 'reservation' ? reservationParser.parse({ subject, html, text })
        : type === 'thankyou'  ? thankyouParser.parse({ subject, html, text })
        :                        cancellationParser.parse({ subject, html, text });

      if (!parsed.ok) {
        await markStatus(gmail_message_id, type, 'failed', parsed.error, null);
        failures.push({ gmail_message_id, subject, error: parsed.error });
        failed++;
        continue;
      }

      // Parser may indicate "skip" — semantically OK but no dispatch (e.g. concession orders).
      if (parsed.skip) {
        await markStatus(gmail_message_id, 'unknown', 'ok', null, null);
        skipped++;
        continue;
      }

      let watch_id = null;
      if (type === 'reservation') {
        const r = await matcher.ingestReservation({
          fields: parsed.fields,
          gmail_message_id,
        });
        watch_id = r.watch_id;
      } else if (type === 'thankyou') {
        const r = await matcher.ingestThankyou({
          fields: parsed.fields,
          gmail_message_id,
          received_at,
        });
        watch_id = r.watch_id;
      } else if (type === 'cancellation') {
        const r = await matcher.ingestCancellation({
          fields: parsed.fields,
          gmail_message_id,
        });
        watch_id = r.watch_id;
      }
      await markStatus(gmail_message_id, type, 'ok', null, watch_id);
      ok++;
    } catch (err) {
      logger.error({ err, gmail_message_id }, 'process row failed');
      const nextAttempts = (row.parse_attempts || 0) + 1;
      const finalStatus = nextAttempts >= MAX_PARSE_ATTEMPTS ? 'failed' : 'pending';
      await pool.query(
        `UPDATE email_log
         SET type = 'unknown',
             parse_status = $1,
             parse_error = $2,
             parsed_at = NOW(),
             parse_attempts = $3,
             last_attempted_at = NOW()
         WHERE gmail_message_id = $4`,
        [finalStatus, err.message, nextAttempts, gmail_message_id]
      );
      failures.push({ gmail_message_id, subject: '(parse exception)', error: err.message });
      failed++;
    }
  }

  if (failures.length) {
    logger.warn(
      `email-poller: ${failures.length} parse failure${failures.length > 1 ? 's' : ''} — see /api/admin/email-log?status=failed`
    );
    failures.slice(0, 5).forEach((f) => {
      logger.warn(`  • ${f.subject || '(no subject)'} — ${f.error}`);
    });
  }

  return { ok, failed, skipped, total: pending.rowCount };
}

async function markStatus(id, type, status, error, watch_id) {
  await pool.query(
    `UPDATE email_log
     SET type = $1, parse_status = $2, parse_error = $3, parsed_at = NOW(), watch_id = $4
     WHERE gmail_message_id = $5`,
    [type, status, error, watch_id, id]
  );
}

let running = false;
async function pollOnce() {
  if (running) {
    logger.info('email-poller: previous run still in progress, skipping');
    return;
  }
  running = true;
  const t0 = Date.now();
  try {
    const ingested = await ingestPhase();
    const processed = await processPhase();
    // Sweep aged-out pending watches immediately so backfills don't have to
    // wait for the daily 03:00 cron to settle into the right statuses.
    await pendingExpirer.expireOnce();
    logger.info(
      `email-poller: ingested ${ingested.newCount}/${ingested.fetched}, ` +
        `processed ${processed.ok} ok / ${processed.failed} failed / ${processed.skipped} skipped ` +
        `(${Date.now() - t0}ms)`
    );
  } catch (err) {
    logger.error({ err: err }, 'email-poller cycle failed');
  } finally {
    running = false;
  }
}

let task = null;
function start() {
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) {
    logger.info('email-poller: GMAIL_USER/GMAIL_APP_PASSWORD not set — skipping');
    return null;
  }
  logger.info('email-poller: starting (every 5 minutes)');
  task = cron.schedule('*/5 * * * *', pollOnce);
  // Run immediately on boot too
  setTimeout(pollOnce, 3000);
  return task;
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, pollOnce, processPhase };
