#!/usr/bin/env node
// One-shot backfill: read the auditorium, seats and ticket count out of the
// reservation email behind every watch that has one. Only fills blanks, so it
// is safe to run again.
//
// Run after migration 018:
//   docker exec marquee node scripts/backfill-seats.js
//   docker exec marquee node scripts/backfill-seats.js --dry-run

require('dotenv').config({ quiet: true, path: require('path').join(__dirname, '..', '..', '.env') });

const { simpleParser } = require('mailparser');
const { pool } = require('../db');
const reservationParser = require('../parsers/amc-reservation');

const dryRun = process.argv.includes('--dry-run');

(async () => {
  const { rows } = await pool.query(
    `SELECT w.id, w.title, el.raw_html
       FROM watches w
       JOIN email_log el ON el.gmail_message_id = w.reservation_email_id
      WHERE w.auditorium IS NULL OR w.seats IS NULL OR w.ticket_count IS NULL
      ORDER BY w.created_at`
  );
  console.log(`${rows.length} watch row(s) with a reservation email and something missing${dryRun ? ' (dry run)' : ''}`);

  let filled = 0;
  let nothing = 0;
  for (const r of rows) {
    let fields = null;
    try {
      const mail = await simpleParser(r.raw_html);
      const parsed = reservationParser.parse({ subject: mail.subject || '', html: mail.html || mail.textAsHtml || '', text: mail.text || '' });
      fields = parsed.fields;
    } catch (err) {
      console.log(`  could not read the email for "${r.title}": ${err.message}`);
    }
    const seats = fields && fields.seats && fields.seats.length ? fields.seats : null;
    if (!fields || (!fields.auditorium && !seats && !fields.ticket_count)) {
      nothing += 1;
      continue;
    }
    if (!dryRun) {
      await pool.query(
        `UPDATE watches SET auditorium = COALESCE(auditorium, $2), seats = COALESCE(seats, $3),
                ticket_count = COALESCE(ticket_count, $4)
          WHERE id = $1`,
        [r.id, fields.auditorium || null, seats, fields.ticket_count || null]
      );
    }
    filled += 1;
    console.log(`  ${r.title}: auditorium ${fields.auditorium || '?'}, ${seats ? `seat${seats.length > 1 ? 's' : ''} ${seats.join(', ')}` : 'no seats listed'}`);
  }
  console.log(`${dryRun ? 'Would fill' : 'Filled'} ${filled}, nothing to read in ${nothing}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
