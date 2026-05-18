#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool, initSchema, runMigrations } = require('../db');
const traktSync = require('../workers/trakt-sync');

async function main() {
  await initSchema();
  await runMigrations();

  const resync = process.argv.includes('--resync');
  const result = await pool.query(
    `UPDATE watches
     SET trakt_sync_requested_at = COALESCE(trakt_sync_requested_at, NOW()),
         trakt_sync_error = NULL,
         trakt_sync_attempts = 0
         ${resync ? ', trakt_synced_at = NULL' : ''}
     WHERE status = 'watched'
       AND tmdb_id IS NOT NULL
       ${resync ? '' : 'AND trakt_synced_at IS NULL'}
     RETURNING id`
  );

  console.log(`Queued ${result.rowCount} watched movie(s) for Trakt sync.`);
  if (result.rowCount === 0) return;

  if (!process.env.TRAKT_CLIENT_ID || !process.env.TRAKT_ACCESS_TOKEN) {
    console.log('TRAKT_CLIENT_ID/TRAKT_ACCESS_TOKEN are not set, so queued rows will sync once Trakt is configured.');
    return;
  }

  // runOnce handles a capped batch; loop until nothing is left queued so the
  // script genuinely finishes rather than reporting one partial batch.
  let synced = 0;
  let batch = 0;
  for (;;) {
    const r = await traktSync.runOnce();
    if (r.total === 0) break;
    synced += r.synced;
    batch += 1;
    console.log(`  batch ${batch}: ${r.synced}/${r.total} synced`);
  }

  console.log(`Done — synced ${synced} movie(s).`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
