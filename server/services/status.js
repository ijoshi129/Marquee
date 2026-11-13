// What the Status sheet shows and what the failure alert watches: one entry per
// background job, built from the run bookkeeping in job-status plus a few
// queries for trouble a job can't see in itself (an email that never parsed, a
// film that ran out of retries, a friend whose instance stopped answering).

const { pool } = require('../db');
const logger = require('../logger');
const jobStatus = require('./job-status');
const fed = require('./federation');
const trakt = require('./trakt');
const ntfy = require('./ntfy');
const nowPlaying = require('./now-playing');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// How long a job must stay broken before the owner is told. Shorter and a
// Reddit hiccup or a friend's reboot becomes a notification.
const ALERT_AFTER_MS = DAY;

const UNSEEN_SQL = `(tags && ARRAY['Screen Unseen', 'Scream Unseen'] OR title ~* 'AMC\\s+(Screen|Scream)\\s+Unseen')`;
const SKIPPED_SQL = `status IN ('cancelled', 'no_show')`;
// Mirrors MAX_RETRIES in the rechecker: past this a regular film is abandoned.
const TMDB_RETRIES = 8;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fileSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// staleMs is how long a scheduled job may go without reporting before that
// silence counts as a failure: a few missed runs, not one. Jobs without it run
// on demand, so silence means nothing.
const JOBS = [
  {
    key: 'email',
    name: 'AMC emails',
    schedule: 'Every 5 minutes',
    staleMs: 30 * MIN,
    enabled: () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD),
    off: 'Gmail is not set up',
    async describe() {
      const { rows } = await pool.query(
        `SELECT MAX(received_at) AS last,
                COUNT(*) FILTER (WHERE parse_status = 'failed')::int AS unread
         FROM email_log`
      );
      const { last, unread } = rows[0];
      return {
        summary: last ? 'Last email' : 'No AMC emails yet',
        summary_at: last || null,
        warning: unread ? `${plural(unread, 'email')} could not be read` : null,
      };
    },
  },
  {
    key: 'unseen',
    name: 'Screen Unseen lookup',
    schedule: 'When a screening needs naming',
    async describe() {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM watches
         WHERE tmdb_id IS NULL AND status = 'watched' AND ${UNSEEN_SQL}`
      );
      const n = rows[0].n;
      return { summary: n ? `${plural(n, 'screening')} still unnamed` : 'Every screening is named' };
    },
  },
  {
    key: 'showtimes',
    name: 'Showtimes',
    schedule: 'When Now Playing is open',
    async describe() {
      const { home } = await nowPlaying.getTheatres();
      return { summary: home ? home.name : 'No home theatre picked' };
    },
  },
  {
    key: 'tmdb',
    name: 'Film details',
    schedule: 'Every 6 hours',
    staleMs: 13 * HOUR,
    async describe() {
      const { rows } = await pool.query(
        `SELECT title FROM watches
         WHERE tmdb_id IS NULL AND NOT ${UNSEEN_SQL} AND NOT ${SKIPPED_SQL}
           AND tmdb_retry_count >= $1
         ORDER BY created_at DESC`,
        [TMDB_RETRIES]
      );
      if (!rows.length) return { summary: 'Every film is matched' };
      return {
        warning:
          rows.length === 1
            ? `No match found for ${rows[0].title}`
            : `${rows.length} films have no match`,
      };
    },
  },
  {
    key: 'friends',
    name: 'Friend sync',
    schedule: 'Every 15 minutes',
    staleMs: 90 * MIN,
    enabled: () => fed.isEnabled(),
    off: 'Friends are switched off',
    async describe() {
      const { rows } = await pool.query(
        `SELECT display_name, last_error FROM friends WHERE friend_url IS NOT NULL`
      );
      const down = rows.filter((r) => r.last_error).map((r) => r.display_name || 'A friend');
      if (down.length) {
        return {
          warning:
            down.length === 1 ? `Cannot reach ${down[0]}` : `Cannot reach ${down.length} friends`,
        };
      }
      return { summary: rows.length ? `${plural(rows.length, 'friend')} in sync` : 'No friends yet' };
    },
  },
  {
    key: 'backup',
    name: 'Backups',
    schedule: 'Every night',
    staleMs: 36 * HOUR,
    enabled: () => Boolean(process.env.BACKUP_DIR),
    off: 'No backup folder is set',
    async describe(state) {
      const size = state.detail && state.detail.size_bytes;
      if (!state.last_ok_at) return { summary: 'No backup yet' };
      return {
        summary: size ? `Last backup, ${fileSize(size)}` : 'Last backup',
        summary_at: state.last_ok_at,
      };
    },
  },
  {
    key: 'cleanup',
    name: 'Nightly cleanup',
    schedule: 'Every night',
    staleMs: 36 * HOUR,
  },
  {
    key: 'trakt',
    name: 'Trakt sync',
    schedule: 'Every 30 minutes',
    staleMs: 3 * HOUR,
    enabled: () => trakt.isConfigured(),
    off: 'Trakt is not connected',
  },
  {
    key: 'push',
    name: 'Phone push',
    schedule: 'When there is something to send',
    enabled: () => Boolean(process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY),
    off: 'Push keys are not set',
    async describe() {
      const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM push_subscriptions');
      const n = rows[0].n;
      return { summary: n ? `${plural(n, 'device')} signed up` : 'No devices signed up' };
    },
  },
  {
    key: 'ntfy',
    name: 'ntfy',
    schedule: 'When there is something to send',
    enabled: async () => {
      const s = await ntfy.getSettings();
      return Boolean(s && s.enabled && s.server_url && s.topic);
    },
    off: 'ntfy is switched off',
  },
];

async function isEnabled(def) {
  if (!def.enabled) return true;
  try {
    return Boolean(await def.enabled());
  } catch {
    return false;
  }
}

// Where a job stands from its own bookkeeping alone:
//   off   not configured        idle  enabled, nothing to report yet
//   ok    last run succeeded    fail  erroring, or silent past staleMs
function assess(def, state, enabled, now = Date.now()) {
  if (!enabled) return { level: 'off' };
  if (state.failing_since) {
    return { level: 'fail', since: state.failing_since, problem: state.last_error || 'Failing' };
  }
  const heard = state.last_run_at || state.since;
  if (def.staleMs && heard && now - Date.parse(heard) > def.staleMs) {
    return {
      level: 'fail',
      stale: true,
      since: new Date(Date.parse(heard) + def.staleMs).toISOString(),
      problem: state.last_run_at ? 'Has stopped running' : 'Has not run',
    };
  }
  if (!state.last_run_at) return { level: 'idle' };
  return { level: 'ok' };
}

// The alert for a job, or null. One failed attempt never alerts on its own: an
// on-demand job can fail once and then have no reason to try again.
function alertFor(def, state, verdict, now = Date.now()) {
  if (verdict.level !== 'fail') return null;
  if (now - Date.parse(verdict.since) < ALERT_AFTER_MS) return null;
  if (!verdict.stale && (state.failures || 0) < 2) return null;
  return {
    key: def.key,
    dedupeKey: `status:${def.key}:${verdict.stale ? 'stale:' : ''}${verdict.since}`,
    title: verdict.stale
      ? `${def.name}: not running for over a day`
      : `${def.name}: failing for over a day`,
    body: verdict.stale ? 'Open Status to see when it last ran.' : state.last_error || null,
  };
}

async function report(now = Date.now()) {
  const jobs = [];
  for (const def of JOBS) {
    const enabled = await isEnabled(def);
    const state = await jobStatus.get(def.key);
    const verdict = assess(def, state, enabled, now);

    let extra = {};
    if (enabled && def.describe) {
      try {
        extra = (await def.describe(state)) || {};
      } catch (err) {
        logger.error(`status: could not describe ${def.key}: ${err.message}`);
      }
    }

    let level = verdict.level;
    let problem = verdict.problem || null;
    if ((level === 'ok' || level === 'idle') && extra.warning) {
      level = 'warn';
      problem = extra.warning;
    }

    jobs.push({
      key: def.key,
      name: def.name,
      schedule: def.schedule,
      level,
      summary: level === 'off' ? def.off || 'Switched off' : extra.summary || null,
      summary_at: level === 'off' ? null : extra.summary_at || null,
      problem,
      last_run_at: state.last_run_at || null,
      last_ok_at: state.last_ok_at || null,
      last_error: state.last_error || null,
      last_error_at: state.last_error_at || null,
      failing_since: verdict.level === 'fail' ? verdict.since : null,
    });
  }

  const count = (lvl) => jobs.filter((j) => j.level === lvl).length;
  const failing = count('fail');
  const warnings = count('warn');
  return {
    checked_at: new Date(now).toISOString(),
    overall: failing ? 'fail' : warnings ? 'warn' : 'ok',
    failing,
    warnings,
    uptime_seconds: Math.round(process.uptime()),
    node: process.version,
    jobs,
  };
}

async function dueAlerts(now = Date.now()) {
  const due = [];
  for (const def of JOBS) {
    const enabled = await isEnabled(def);
    const state = await jobStatus.get(def.key);
    const alert = alertFor(def, state, assess(def, state, enabled, now), now);
    if (alert) due.push(alert);
  }
  return due;
}

// Stamp a start time on every enabled job, so one that never reports is
// noticed too.
async function watchEnabled() {
  for (const def of JOBS) {
    if (await isEnabled(def)) await jobStatus.watch(def.key);
  }
}

module.exports = { JOBS, assess, alertFor, report, dueAlerts, watchEnabled, ALERT_AFTER_MS };
