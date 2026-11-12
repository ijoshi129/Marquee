// Every 6 hours: revisit watches with tmdb_id IS NULL and re-attempt resolution.
//
//   - AMC Screen/Scream Unseens → unseenLookup.resolveAndAssign (walks r/AMCsAList).
//   - Everything else            → tmdb.autoMatch on the raw title.
//
// Each unsuccessful attempt bumps tmdb_retry_count; after MAX_RETRIES the row
// drops out of the candidate pool so we don't pound TMDB/Reddit forever on a
// permanently unresolvable title. Manual "Re-check" from the edit modal
// resets the counter so the auto-loop can resume.
//
// Unseens outlast that: a reveal can reach the megathread days after the
// screening, so once the 6-hourly attempts run out they drop to one a day for
// about three more weeks, and the owner is asked to identify the film meanwhile.

const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');
const unseenLookup = require('../services/unseen-lookup');
const tmdb = require('../services/tmdb');
const notifications = require('../services/notifications');

const MAX_RETRIES = 8;
const UNSEEN_MAX_RETRIES = MAX_RETRIES + 19;
// Just under a day, so the daily attempt lands on the same cron slot each time.
const UNSEEN_SLOW_GAP_MS = 23 * 60 * 60 * 1000;
const BATCH_LIMIT = 50;
const UNSEEN_RX = /AMC\s+(?:Screen|Scream)\s+Unseen/i;

// An Unseen is a mystery screening — resolving its title before the owner has
// actually seen the film would spoil it right in the diary. Reveal it 2h after
// the showtime, roughly when the film lets out, so the title never surfaces
// during the screening.
const APP_TIME_ZONE = process.env.APP_TIMEZONE || process.env.TZ || 'America/New_York';
const UNSEEN_REVEAL_AFTER_MS = 2 * 60 * 60 * 1000;

// Showtimes are stored as the printed wall-clock time labelled UTC, so the
// stored instant isn't real. Reinterpret those wall-clock parts in the owner's
// timezone to recover the true instant (DST handled by Intl).
function realShowtimeMs(showtime) {
  const wallAsUtc = new Date(showtime).getTime();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: APP_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
    .formatToParts(new Date(wallAsUtc))
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallAsUtc - (shown - wallAsUtc);
}
function unseenRevealed(showtime) {
  if (!showtime) return true; // nothing to gate on
  return Date.now() >= realShowtimeMs(showtime) + UNSEEN_REVEAL_AFTER_MS;
}

function isUnseen(row) {
  const tags = row.tags || [];
  if (tags.includes('Screen Unseen') || tags.includes('Scream Unseen')) return true;
  return UNSEEN_RX.test(row.title || '');
}

function inSlowPhase(row) {
  return isUnseen(row) && (row.tmdb_retry_count || 0) >= MAX_RETRIES;
}

function triedRecently(row) {
  if (!row.tmdb_last_retry_at) return false;
  return Date.now() - new Date(row.tmdb_last_retry_at).getTime() < UNSEEN_SLOW_GAP_MS;
}

async function askOwnerToIdentify(row) {
  if (row.status === 'cancelled' || row.status === 'no_show') return;
  const kind = /Scream/i.test(`${(row.tags || []).join(' ')} ${row.title || ''}`) ? 'Scream' : 'Screen';
  const when = row.showtime || row.watched_at;
  // Showtimes are wall-clock labelled UTC, so UTC recovers the printed date.
  const day = when
    ? new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(when))
    : null;
  await notifications.notify({
    kind: 'identify',
    title: day ? `What was your ${kind} Unseen on ${day}?` : `What was your ${kind} Unseen?`,
    body: "The reveal hasn't turned up yet. Tap to pick the film. Marquee will keep checking.",
    payload: { watch_id: row.id },
    dedupeKey: `identify:${row.id}`,
  });
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
      `SELECT id, title, tags, status, showtime, watched_at,
              tmdb_retry_count, tmdb_last_retry_at
       FROM watches
       WHERE tmdb_id IS NULL
         AND tmdb_retry_count < CASE
               WHEN tags && ARRAY['Screen Unseen', 'Scream Unseen'] OR title ~* $3
                 THEN $2::int
               ELSE $1::int
             END
       ORDER BY COALESCE(tmdb_last_retry_at, created_at) ASC
       LIMIT $4`,
      [MAX_RETRIES, UNSEEN_MAX_RETRIES, UNSEEN_RX.source, BATCH_LIMIT]
    );

    let checked = 0;
    let resolved = 0;
    let abandoned = 0;

    for (const row of candidates.rows) {
      // Leave pre-showtime Unseens untouched — don't resolve (anti-spoiler) and
      // don't burn a retry, so they're still eligible once the showtime passes.
      if (isUnseen(row) && !unseenRevealed(row.showtime)) continue;
      if (inSlowPhase(row) && triedRecently(row)) continue;
      checked++;
      let hit = false;
      let errored = false;
      try {
        hit = await recheckOne(row);
      } catch (err) {
        // Transient failure (network blip, TMDB 429/5xx) — don't penalise the
        // row, or a brief outage would permanently abandon resolvable films.
        // Only a clean "no match" burns a retry.
        errored = true;
        logger.error({ err, watch_id: row.id }, 'tmdb-rechecker: row failed (transient, no retry burned)');
      }
      if (hit) {
        resolved++;
        continue;
      }
      if (errored) continue;
      const next = (row.tmdb_retry_count || 0) + 1;
      if (next >= (isUnseen(row) ? UNSEEN_MAX_RETRIES : MAX_RETRIES)) abandoned++;
      await pool.query(
        `UPDATE watches
         SET tmdb_retry_count = tmdb_retry_count + 1,
             tmdb_last_retry_at = NOW()
         WHERE id = $1`,
        [row.id]
      );
      if (isUnseen(row) && next === MAX_RETRIES) {
        await askOwnerToIdentify(row).catch((err) =>
          logger.error({ err, watch_id: row.id }, 'tmdb-rechecker: identify nudge failed')
        );
      }
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
