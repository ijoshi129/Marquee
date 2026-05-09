#!/usr/bin/env node
// End-to-end test: load all fixture .eml files into email_log, then run processPhase
// and dump the resulting watch rows.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const { pool } = require('../db');
const poller = require('../workers/email-poller');

async function main() {
  const dirs = [
    path.join(__dirname, '..', '..', 'fixtures', 'reservations'),
    path.join(__dirname, '..', '..', 'fixtures', 'thankyous'),
  ];
  let inserted = 0;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.eml'))) {
      const fp = path.join(dir, file);
      const raw = fs.readFileSync(fp);
      const mail = await simpleParser(raw);
      const messageId = mail.messageId || `fixture-${file}`;
      const r = await pool.query(
        `INSERT INTO email_log (gmail_message_id, type, received_at, raw_html, parse_status)
         VALUES ($1, 'unknown', $2, $3, 'pending')
         ON CONFLICT (gmail_message_id) DO UPDATE
           SET parse_status = 'pending', parse_error = NULL, watch_id = NULL
         RETURNING gmail_message_id`,
        [messageId, mail.date || new Date(), raw.toString('utf8')]
      );
      if (r.rows.length) inserted++;
    }
  }
  console.log(`Loaded ${inserted} fixtures into email_log (re-queued any existing)`);

  // Reset previously-imported amc_email watches so the test is clean
  await pool.query(`DELETE FROM watches WHERE source = 'amc_email'`);

  const processed = await poller.processPhase();
  console.log('processPhase result:', processed);

  const watches = await pool.query(
    `SELECT w.title, w.status, w.order_number, w.showtime, w.watched_at,
            t.name AS theater
     FROM watches w
     LEFT JOIN theaters t ON t.id = w.theater_id
     WHERE w.source = 'amc_email'
     ORDER BY w.showtime`
  );
  console.log('\nResulting amc_email watches:');
  console.table(watches.rows);

  const log = await pool.query(
    `SELECT type, parse_status, parse_error
     FROM email_log
     ORDER BY received_at`
  );
  console.log('\nemail_log:');
  console.table(log.rows);

  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
