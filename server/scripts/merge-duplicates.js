#!/usr/bin/env node
// One-shot: find pending watches whose Thank-You created a walk-up duplicate
// (because format/language suffixes broke the title match), and merge them.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool } = require('../db');
const { normalizeText, cleanTitle } = require('../utils/normalize');

const normTitle = (t) => normalizeText(cleanTitle(t));

(async () => {
  const pendings = (
    await pool.query(
      `SELECT id, title, theater_id, showtime
       FROM watches
       WHERE status = 'pending' AND source = 'amc_email' AND showtime IS NOT NULL`
    )
  ).rows;

  let merged = 0;
  for (const p of pendings) {
    const pNorm = normTitle(p.title);
    if (!pNorm) continue;

    // Walk-up candidates: same theater, source amc_email, status watched, no order_number,
    // watched_at within 24h after showtime.
    const before = new Date(p.showtime).toISOString();
    const after = new Date(new Date(p.showtime).getTime() + 24 * 3600_000).toISOString();
    const walkups = (
      await pool.query(
        `SELECT id, title, watched_at, thankyou_email_id, tmdb_id, tmdb_needs_review
         FROM watches
         WHERE status = 'watched' AND source = 'amc_email' AND order_number IS NULL
           AND theater_id = $1
           AND watched_at BETWEEN $2 AND $3`,
        [p.theater_id, before, after]
      )
    ).rows;

    const matches = walkups.filter((w) => normTitle(w.title) === pNorm);
    if (matches.length === 0) continue;

    // Pick walk-up whose watched_at is closest to showtime + 2h (typical post-show delay).
    const target = new Date(p.showtime).getTime() + 2 * 3600_000;
    matches.sort((a, b) => {
      const da = Math.abs(new Date(a.watched_at).getTime() - target);
      const db = Math.abs(new Date(b.watched_at).getTime() - target);
      return da - db;
    });
    const w = matches[0];

    const cleaned = cleanTitle(p.title) || cleanTitle(w.title);

    // Promote pending → watched with walk-up's metadata; prefer walk-up's TMDB if pending's missing.
    await pool.query(
      `UPDATE watches
       SET status='watched',
           watched_at=$1,
           thankyou_email_id=$2,
           title=$3,
           tmdb_id = COALESCE(tmdb_id, $4),
           tmdb_needs_review = CASE WHEN tmdb_id IS NULL THEN $5 ELSE tmdb_needs_review END,
           updated_at=NOW()
       WHERE id=$6`,
      [w.watched_at, w.thankyou_email_id, cleaned, w.tmdb_id, w.tmdb_needs_review, p.id]
    );

    // Repoint email_log.watch_id from the walk-up to the merged row.
    if (w.thankyou_email_id) {
      await pool.query(
        `UPDATE email_log SET watch_id = $1 WHERE gmail_message_id = $2`,
        [p.id, w.thankyou_email_id]
      );
    }

    await pool.query(`DELETE FROM watches WHERE id = $1`, [w.id]);
    merged++;
    console.log(`Merged: "${p.title}" + walk-up "${w.title}" → "${cleaned}"`);
  }

  console.log(`\nMerged ${merged} duplicate(s).`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
