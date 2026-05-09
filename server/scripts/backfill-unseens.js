#!/usr/bin/env node
// One-shot backfill: resolve every existing AMC Screen/Scream Unseen watch
// against the r/AMCsAList megathreads.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool } = require('../db');
const unseenLookup = require('../services/unseen-lookup');

(async () => {
  const rows = (
    await pool.query(
      `SELECT id, title, showtime, watched_at, tmdb_id
       FROM watches
       WHERE title ILIKE 'AMC %Unseen%'
       ORDER BY COALESCE(showtime, watched_at)`
    )
  ).rows;

  console.log(`Found ${rows.length} AMC Screen/Scream Unseen watches`);

  let resolved = 0;
  let already = 0;
  let skipped = 0;
  for (const w of rows) {
    if (w.tmdb_id) {
      console.log(`  skip "${w.title}" (already has tmdb_id=${w.tmdb_id})`);
      already++;
      continue;
    }
    try {
      const result = await unseenLookup.resolveAndAssign(w.id);
      if (result.resolved) {
        console.log(
          `  ✓ "${w.title}" → "${result.title}" (tmdb_id=${result.tmdbId || 'n/a'})`
        );
        resolved++;
      } else {
        console.log(`  ✗ "${w.title}" — ${result.reason}`);
        skipped++;
      }
    } catch (err) {
      console.error(`  ! "${w.title}" — ${err.message}`);
      skipped++;
    }
  }
  console.log(`\nDone — resolved ${resolved}, already-enriched ${already}, skipped ${skipped}`);
  await pool.end();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
