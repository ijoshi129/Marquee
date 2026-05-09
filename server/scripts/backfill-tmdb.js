#!/usr/bin/env node
// One-shot backfill: run TMDB enrichment on any watch (any status) that doesn't
// have a tmdb_id yet. Useful after parser changes or when adding TMDB to a code path.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool } = require('../db');
const tmdb = require('../services/tmdb');

(async () => {
  const rows = (
    await pool.query(
      `SELECT id, title FROM watches WHERE tmdb_id IS NULL ORDER BY created_at`
    )
  ).rows;
  console.log(`Backfilling TMDB for ${rows.length} watches`);

  let enriched = 0;
  let needsReview = 0;
  for (const r of rows) {
    try {
      const m = await tmdb.autoMatch(r.title);
      if (m) {
        await pool.query(
          `UPDATE watches SET tmdb_id=$1, tmdb_needs_review=$2, updated_at=NOW() WHERE id=$3`,
          [m.tmdb_id, m.needs_review, r.id]
        );
        enriched++;
        if (m.needs_review) needsReview++;
      } else {
        await pool.query(
          `UPDATE watches SET tmdb_needs_review=TRUE, updated_at=NOW() WHERE id=$1`,
          [r.id]
        );
        needsReview++;
      }
    } catch (err) {
      console.error(`  failed for "${r.title}": ${err.message}`);
    }
  }
  console.log(`Done — enriched ${enriched}, needs_review ${needsReview}`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
