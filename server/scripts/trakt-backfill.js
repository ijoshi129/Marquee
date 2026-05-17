#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool, initSchema, runMigrations } = require('../db');
const traktSync = require('../workers/trakt-sync');

async function main() {
  await initSchema();
  await runMigrations();

  const resync = process.argv.includes('--resync');
  const whereSynced = resync ? '' : 'AND trakt_synced_at IS NULL';
  const result = await pool.query(
    `UPDATE watches
     SET trakt_sync_requested_at = COALESCE(trakt_sync_requested_at, NOW()),
         trakt_sync_error = NULL,
         trakt_sync_attempts = 0
         ${resync ? ', trakt_synced_at = NULL' : ''}
     WHERE status = 'watched'
       AND tmdb_id IS NOT NULL
       ${whereSynced}
     RETURNING id`
  );

  console.log(`Queued ${result.rowCount} watched movie(s) for Trakt sync.`);

  if (!process.env.TRAKT_CLIENT_ID || !process.env.TRAKT_ACCESS_TOKEN) {
    console.log('TRAKT_CLIENT_ID/TRAKT_ACCESS_TOKEN are not set, so queued rows will sync after Trakt is configured.');
    return;
  }

  const synced = await traktSync.runOnce();
  console.log(`Synced ${synced.synced}/${synced.total} queued movie(s) in this run.`);
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
