const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');
const trakt = require('../services/trakt');

const MAX_ATTEMPTS = 8;

let running = false;

async function runOnce() {
  if (!trakt.isConfigured()) {
    logger.info('trakt-sync: TRAKT_CLIENT_ID/TRAKT_ACCESS_TOKEN not set — skipping');
    return { total: 0, synced: 0 };
  }
  if (running) {
    logger.info('trakt-sync: previous run still in progress, skipping');
    return { total: 0, synced: 0 };
  }

  running = true;
  try {
    const pending = await pool.query(
      `SELECT id
       FROM watches
       WHERE trakt_sync_requested_at IS NOT NULL
         AND trakt_synced_at IS NULL
         AND trakt_sync_attempts < $1
         AND status = 'watched'
         AND tmdb_id IS NOT NULL
       ORDER BY trakt_sync_requested_at ASC
       LIMIT 50`,
      [MAX_ATTEMPTS]
    );

    let synced = 0;
    for (const row of pending.rows) {
      const result = await trakt.syncWatch(row.id);
      if (result.synced) synced++;
    }
    if (pending.rowCount > 0) {
      logger.info(`trakt-sync: synced ${synced}/${pending.rowCount} queued watch(es)`);
    }
    return { total: pending.rowCount, synced };
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
