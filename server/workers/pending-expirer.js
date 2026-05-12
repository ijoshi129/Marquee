// Daily cron + post-poll sweep that settles the lifecycle of AMC-email-driven
// watches after their showtime passes.
//
// Two stages, both driven by the row's `showtime`:
//
//   1. showtime + 24h  →  flip pending → watched silently. Reasoning:
//      cancellation emails arrive instantly when you cancel, so a row that's
//      still 'pending' a day after showtime almost certainly means the user
//      attended (or no-showed). We default to watched because that's the
//      common case; the 4-day check below catches the rest.
//      NOTE: deliberately does NOT bump `updated_at`, so the
//      `created_at = updated_at` guard on step 2 still detects "user hasn't
//      touched this row" correctly.
//
//   2. showtime + 4d  →  if the row is 'watched' but never received a
//      thank-you email, surface a bulletin prompt asking the user to confirm
//      ("I went" / "No-show" / "I cancelled it"). Thank-yous can be 1–4 days
//      late or never arrive, so this is the cross-check on step 1's assumption.
//      The prompt persists indefinitely — until the user clicks one of the
//      three actions or explicitly dismisses. Skips rows the user has already
//      engaged with (rated, noted, or touched).
//
// Manual entries (source='manual') are never touched — those are explicit user
// choices that shouldn't auto-mutate.

const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');

const AUTO_WATCHED_AFTER_HOURS = 24;
const NEEDS_CONFIRM_DAYS = 4;
const EMAIL_LOG_RETENTION_DAYS = 730; // 2 years

async function expireOnce() {
  // (1) Past-showtime pending → silently watched.
  const watchedR = await pool.query(
    `UPDATE watches
     SET status = 'watched',
         watched_at = COALESCE(watched_at, showtime)
     WHERE status = 'pending'
       AND source = 'amc_email'
       AND showtime IS NOT NULL
       AND showtime < NOW() - INTERVAL '${AUTO_WATCHED_AFTER_HOURS} hours'
     RETURNING id`
  );
  if (watchedR.rowCount > 0) {
    logger.info(
      `pending-expirer: auto-watched ${watchedR.rowCount} row(s) (showtime > ${AUTO_WATCHED_AFTER_HOURS}h ago)`
    );
  }

  // (2) Watched + no thank-you + past confirm window → surface bulletin prompt.
  // No upper bound: the prompt stays in the bulletin until the user resolves it.
  const confirmR = await pool.query(
    `UPDATE watches
     SET acknowledged = FALSE, updated_at = NOW()
     WHERE status = 'watched'
       AND source = 'amc_email'
       AND thankyou_email_id IS NULL
       AND acknowledged = TRUE
       AND showtime IS NOT NULL
       AND showtime < NOW() - INTERVAL '${NEEDS_CONFIRM_DAYS} days'
       AND rating IS NULL
       AND notes IS NULL
       AND created_at = updated_at
     RETURNING id`
  );
  if (confirmR.rowCount > 0) {
    logger.info(
      `pending-expirer: flagged ${confirmR.rowCount} row(s) for confirmation (showtime > ${NEEDS_CONFIRM_DAYS}d ago, no thank-you email)`
    );
  }

  return {
    watched: watchedR.rowCount,
    confirm: confirmR.rowCount,
  };
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
