// Daily cron + post-poll sweep that ages out stale `pending` watches.
//
// Two windows:
//   1. showtime > 30 days ago  →  flip to 'watched' silently (auto-ack).
//      Old reservation, no thank-you and no cancellation in the inbox →
//      overwhelmingly likely the user attended and the thank-you was just
//      deleted/archived. No reason to bug them.
//   2. showtime 7–30 days ago  →  stays 'pending', but un-acknowledge so it
//      surfaces in the bulletin asking "did you go or did you miss it?".
//      User picks "I went" (→ watched) or "Missed it" (→ no_show).
//
// The 7–30d sweep only fires on rows the user hasn't touched yet
// (created_at = updated_at), so dismissing a notification doesn't
// repeatedly re-flag the same row.

const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');

const ASSUMED_WATCHED_DAYS = 30;
const NEEDS_CONFIRM_DAYS = 7;
const EMAIL_LOG_RETENTION_DAYS = 730; // 2 years

async function expireOnce() {
  // (1) Old reservations → assumed watched.
  const watchedR = await pool.query(
    `UPDATE watches
     SET status = 'watched',
         acknowledged = TRUE,
         watched_at = COALESCE(watched_at, showtime),
         updated_at = NOW()
     WHERE status = 'pending'
       AND showtime IS NOT NULL
       AND showtime < NOW() - INTERVAL '${ASSUMED_WATCHED_DAYS} days'
     RETURNING id`
  );
  if (watchedR.rowCount > 0) {
    logger.info(
      `pending-expirer: marked ${watchedR.rowCount} as watched (showtime > ${ASSUMED_WATCHED_DAYS}d ago)`
    );
  }

  // (2) Recent stale reservations → still pending, but flag for user confirmation.
  const confirmR = await pool.query(
    `UPDATE watches
     SET acknowledged = FALSE, updated_at = NOW()
     WHERE status = 'pending'
       AND showtime IS NOT NULL
       AND showtime < NOW() - INTERVAL '${NEEDS_CONFIRM_DAYS} days'
       AND showtime >= NOW() - INTERVAL '${ASSUMED_WATCHED_DAYS} days'
       AND created_at = updated_at`
  );
  if (confirmR.rowCount > 0) {
    logger.info(
      `pending-expirer: flagged ${confirmR.rowCount} pending watches for user confirmation (${NEEDS_CONFIRM_DAYS}-${ASSUMED_WATCHED_DAYS}d ago)`
    );
  }

  return { watched: watchedR.rowCount, confirm: confirmR.rowCount };
}

// Delete email_log rows older than the retention window. The raw_html column
// is the bulk of the size; once a watch has been promoted/cancelled the
// source email is rarely useful. Watch_id FKs cascade-NULL so existing
// watches keep their pointers.
async function pruneEmailLog() {
  const r = await pool.query(
    `DELETE FROM email_log
     WHERE received_at < NOW() - INTERVAL '${EMAIL_LOG_RETENTION_DAYS} days'`
  );
  if (r.rowCount > 0) {
    logger.info(
      `pending-expirer: pruned ${r.rowCount} email_log rows older than ${EMAIL_LOG_RETENTION_DAYS}d`
    );
  }
  return r.rowCount;
}

async function dailyMaintenance() {
  await expireOnce();
  await pruneEmailLog();
}

let task = null;
function start() {
  logger.info('pending-expirer: starting (daily at 03:00)');
  task = cron.schedule('0 3 * * *', dailyMaintenance);
  return task;
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, expireOnce, pruneEmailLog };
