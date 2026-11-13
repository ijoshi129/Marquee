// Last-run bookkeeping for the background jobs, so the Status sheet and the
// failure alert have something to read. One JSON blob per job in app_state:
//
//   { since, last_run_at, last_ok_at, last_error, last_error_at,
//     failing_since, failures, detail }
//
// Recording must never break the job it reports on, so nothing here throws.

const { pool } = require('../db');
const logger = require('../logger');

const KEY_PREFIX = 'job:';
const MAX_ERROR_LENGTH = 300;

// Fallback only: every read goes to the database, so a one-off script
// recording a run in another process is seen here too. The copy is what a job
// carries on from if a read fails, rather than starting its history over.
const cache = new Map();

async function get(job) {
  try {
    const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [
      KEY_PREFIX + job,
    ]);
    const state = rows[0] ? JSON.parse(rows[0].value) : {};
    cache.set(job, state);
    return state;
  } catch (err) {
    logger.error(`job-status: could not read ${job}: ${err.message}`);
    return cache.get(job) || {};
  }
}

async function put(job, state) {
  cache.set(job, state);
  try {
    await pool.query(
      `INSERT INTO app_state (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [KEY_PREFIX + job, JSON.stringify(state)]
    );
  } catch (err) {
    logger.error(`job-status: could not record ${job}: ${err.message}`);
  }
  return state;
}

// Start the clock for a job that has never reported, so "hasn't run in a day"
// is measured from when it was first expected to, not from the epoch.
async function watch(job) {
  const prev = await get(job);
  if (prev.since) return prev;
  return put(job, { ...prev, since: new Date().toISOString() });
}

async function succeeded(job, detail = null) {
  const prev = await get(job);
  const now = new Date().toISOString();
  return put(job, {
    ...prev,
    since: prev.since || now,
    last_run_at: now,
    last_ok_at: now,
    failing_since: null,
    failures: 0,
    detail,
  });
}

async function failed(job, err) {
  const prev = await get(job);
  const now = new Date().toISOString();
  // Two libraries put the useful part somewhere other than the message:
  // fetch() calls every network failure "fetch failed" and keeps the reason on
  // its cause, and the IMAP client calls every refusal "Command failed" and
  // keeps the server's own words on responseText.
  const cause = err && err.cause && (err.cause.code || err.cause.message);
  const reason = (err && err.responseText) || cause;
  const message = `${(err && err.message) || err || 'failed'}${reason ? ` (${reason})` : ''}`.slice(
    0,
    MAX_ERROR_LENGTH
  );
  return put(job, {
    ...prev,
    since: prev.since || now,
    last_run_at: now,
    last_error: message,
    last_error_at: now,
    failing_since: prev.failing_since || now,
    failures: (prev.failures || 0) + 1,
  });
}

function clearCache() {
  cache.clear();
}

module.exports = { get, watch, succeeded, failed, clearCache };
