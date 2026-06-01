#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool, initSchema, runMigrations } = require('../db');
const traktSync = require('../workers/trakt-sync');

function argValue(name) {
  const prefix = `${name}=`;
  const i = process.argv.findIndex((arg) => arg === name || arg.startsWith(prefix));
  if (i === -1) return null;
  const arg = process.argv[i];
  if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  return process.argv[i + 1] || null;
}

function argValues(...names) {
  const out = [];
  for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    for (const name of names) {
      const prefix = `${name}=`;
      if (arg === name && process.argv[i + 1]) out.push(process.argv[i + 1]);
      else if (arg.startsWith(prefix)) out.push(arg.slice(prefix.length));
    }
  }
  return out.flatMap((value) => String(value).split(',')).map((value) => value.trim()).filter(Boolean);
}

async function main() {
  await initSchema();
  await runMigrations();

  const resync = process.argv.includes('--resync');
  const watchIds = argValues('--watch-id', '--id');
  const limitRaw = argValue('--limit');
  const limit = limitRaw == null ? null : parseInt(limitRaw, 10);
  if (limitRaw != null && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  const where = [`status = 'watched'`, `tmdb_id IS NOT NULL`];
  const params = [];
  if (!resync) where.push(`trakt_synced_at IS NULL`);
  if (watchIds.length) {
    params.push(watchIds);
    where.push(`id = ANY($${params.length}::uuid[])`);
  }
  const limitSql = limit ? `LIMIT $${params.push(limit)}` : '';

  const result = await pool.query(
    `UPDATE watches
     SET trakt_sync_requested_at = COALESCE(trakt_sync_requested_at, NOW()),
         trakt_sync_error = NULL,
         trakt_sync_attempts = 0
         ${resync ? ', trakt_synced_at = NULL' : ''}
     WHERE id IN (
       SELECT id
       FROM watches
       WHERE ${where.join(' AND ')}
       ORDER BY COALESCE(watched_at, showtime, created_at) ASC
       ${limitSql}
     )
     RETURNING id`,
    params
  );

  console.log(`Queued ${result.rowCount} watched movie(s) for Trakt sync.`);
  if (result.rowCount === 0) return;
  const queuedIds = result.rows.map((row) => row.id);

  if (!process.env.TRAKT_CLIENT_ID || !process.env.TRAKT_ACCESS_TOKEN) {
    console.log('TRAKT_CLIENT_ID/TRAKT_ACCESS_TOKEN are not set, so queued rows will sync once Trakt is configured.');
    return;
  }

  // runOnce handles a capped batch; loop until nothing is left queued so the
  // script genuinely finishes rather than reporting one partial batch.
  let synced = 0;
  let posted = 0;
  let alreadySynced = 0;
  let failed = 0;
  let batch = 0;
  for (;;) {
    const r = await traktSync.runOnce({ watchIds: queuedIds });
    if (r.total === 0) break;
    synced += r.synced;
    posted += r.posted || 0;
    alreadySynced += r.alreadySynced || 0;
    failed += r.failed || 0;
    batch += 1;
    console.log(
      `  batch ${batch}: ${r.posted || 0} posted, ${r.alreadySynced || 0} already on Trakt, ${r.failed || 0} failed, ${r.synced}/${r.total} marked synced`
    );
    if (r.synced === 0) {
      console.log('Stopping because the last batch made no progress. Fix the reported errors, then rerun backfill.');
      break;
    }
  }

  console.log(
    `Done — ${posted} posted, ${alreadySynced} already existed on Trakt, ${failed} failed, ${synced} total marked synced.`
  );
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
