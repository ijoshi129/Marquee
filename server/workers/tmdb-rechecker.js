// Every 6 hours: revisit watches with tmdb_id IS NULL and re-attempt resolution.
//
//   - AMC Screen/Scream Unseens → unseenLookup.resolveAndAssign (walks r/AMCsAList).
//   - Everything else            → tmdb.autoMatch on the raw title.
//
// Each unsuccessful attempt bumps tmdb_retry_count; after MAX_RETRIES the row
// drops out of the candidate pool so we don't pound TMDB/Reddit forever on a
// permanently unresolvable title. Manual "Re-check" from the edit modal
// resets the counter so the auto-loop can resume.

const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');
const unseenLookup = require('../services/unseen-lookup');
const tmdb = require('../services/tmdb');

const MAX_RETRIES = 8;
const BATCH_LIMIT = 50;
const UNSEEN_RX = /AMC\s+(?:Screen|Scream)\s+Unseen/i;

function isUnseen(row) {
  const tags = row.tags || [];
  if (tags.includes('Screen Unseen') || tags.includes('Scream Unseen')) return true;
  return UNSEEN_RX.test(row.title || '');
}

async function recheckOne(row) {
  if (isUnseen(row)) {
    const result = await unseenLookup.resolveAndAssign(row.id);
    return !!(result && result.resolved);
  }
  const match = await tmdb.autoMatch(row.title, {
    year: tmdb.yearOf(row.showtime || row.watched_at),
  });
  if (!match) return false;
  await pool.query(
    `UPDATE watches
     SET tmdb_id = $1, tmdb_needs_review = $2, updated_at = NOW()
     WHERE id = $3`,
    [match.tmdb_id, !!match.needs_review, row.id]
  );
  return true;
}

let running = false;
async function recheckOnce() {
  if (running) {
    logger.info('tmdb-rechecker: previous run still in progress, skipping');
    return;
  }
  running = true;
  const t0 = Date.now();
  try {
    const candidates = await pool.query(
      `SELECT id, title, tags, showtime, watched_at, tmdb_retry_count
       FROM watches
       WHERE tmdb_id IS NULL
         AND tmdb_retry_count < $1
       ORDER BY COALESCE(tmdb_last_retry_at, created_at) ASC
       LIMIT $2`,
      [MAX_RETRIES, BATCH_LIMIT]
    );

    let checked = 0;
    let resolved = 0;
    let abandoned = 0;

    for (const row of candidates.rows) {
      checked++;
      let hit = false;
      try {
        hit = await recheckOne(row);
      } catch (err) {
        logger.error({ err, watch_id: row.id }, 'tmdb-rechecker: row failed');
      }
      if (hit) {
        resolved++;
        continue;
      }
      const next = (row.tmdb_retry_count || 0) + 1;
      if (next >= MAX_RETRIES) abandoned++;
      await pool.query(
        `UPDATE watches
         SET tmdb_retry_count = tmdb_retry_count + 1,
             tmdb_last_retry_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
    }

    logger.info(
      { checked, resolved, abandoned, ms: Date.now() - t0 },
      'tmdb-rechecker: cycle done'
    );
  } catch (err) {
    logger.error({ err }, 'tmdb-rechecker cycle failed');
  } finally {
    running = false;
  }
}

let task = null;
function start() {
  logger.info('tmdb-rechecker: starting (every 6 hours)');
  task = cron.schedule('0 */6 * * *', recheckOnce);
  setTimeout(recheckOnce, 30_000);
  return task;
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, recheckOnce };
