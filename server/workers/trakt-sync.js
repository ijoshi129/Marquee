const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');
const trakt = require('../services/trakt');

const MAX_ATTEMPTS = 8;

let running = false;

async function runOnce(opts = {}) {
  const watchIds = Array.isArray(opts.watchIds) ? opts.watchIds.filter(Boolean) : [];
  if (!trakt.isConfigured()) {
    logger.info('trakt-sync: TRAKT_CLIENT_ID/TRAKT_ACCESS_TOKEN not set — skipping');
    return { total: 0, synced: 0, posted: 0, alreadySynced: 0, failed: 0 };
  }
  if (running) {
    logger.info('trakt-sync: previous run still in progress, skipping');
    return { total: 0, synced: 0, posted: 0, alreadySynced: 0, failed: 0 };
  }

  running = true;
  try {
    const params = [MAX_ATTEMPTS];
    const idFilter = watchIds.length
      ? `AND id = ANY($${params.push(watchIds)}::uuid[])`
      : '';
    const pending = await pool.query(
      `SELECT id
       FROM watches
       WHERE trakt_sync_requested_at IS NOT NULL
         AND trakt_synced_at IS NULL
         AND trakt_sync_attempts < $1
         AND status = 'watched'
         AND tmdb_id IS NOT NULL
         ${idFilter}
       ORDER BY trakt_sync_attempts ASC, trakt_sync_requested_at ASC
       LIMIT 50`,
      params
    );

    let synced = 0;
    let posted = 0;
    let alreadySynced = 0;
    let failed = 0;
    for (const row of pending.rows) {
      const result = await trakt.syncWatch(row.id);
      if (result.synced) synced++;
      if (result.synced && result.skipped !== 'already_on_trakt') posted++;
      if (result.skipped === 'already_on_trakt') alreadySynced++;
      if (!result.synced && result.error) failed++;
    }
    if (pending.rowCount > 0) {
      logger.info(
        `trakt-sync: posted ${posted}, already on Trakt ${alreadySynced}, failed ${failed}, synced ${synced}/${pending.rowCount} queued watch(es)`
      );
    }
    return { total: pending.rowCount, synced, posted, alreadySynced, failed };
  } finally {
    running = false;
  }
}

let task = null;
function start() {
  if (!trakt.isConfigured()) {
    logger.info('trakt-sync: TRAKT_CLIENT_ID/TRAKT_ACCESS_TOKEN not set — skipping');
    return null;
  }
  logger.info('trakt-sync: starting (every 30 minutes)');
  task = cron.schedule('*/30 * * * *', runOnce);
  setTimeout(runOnce, 10000);
  return task;
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, runOnce };
