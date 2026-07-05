// Pulls each friend's shared feed on an interval and caches it locally so the
// Friends UI is fast and survives a friend being offline. The friend's
// capability URL is the whole credential; one friend failing never blocks the
// others. Any failure keeps the stale cache in place and records last_error —
// there's no revoked state, so a friend who rotates their URL just shows an
// error until the owner pastes the fresh one.

const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');
const fed = require('../services/federation');
const { notifyNewMatches } = require('../services/together');

const SYNC_INTERVAL_MIN = parseInt(process.env.FEDERATION_SYNC_INTERVAL_MIN, 10) || 15;
const REQUEST_TIMEOUT_MS = 10_000;

async function fetchFeed(friend) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${friend.friend_url}/feed`, { signal: controller.signal });
    if (resp.status === 401 || resp.status === 404) {
      throw new Error('Access rejected — ask them for a fresh URL');
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function syncFriend(friend) {
  const feed = await fetchFeed(friend);

  // Full replace, not incremental: re-pulling the whole shared set is what makes
  // edits propagate — a re-rated film updates, and a film the friend marked
  // private (or deleted) disappears from our cache. Cheap at personal scale.
  // Watches, profile, and identity are written in one transaction so a mid-sync
  // failure can never leave a half-updated snapshot.
  const watches = Array.isArray(feed.watches) ? feed.watches : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM friend_watches WHERE friend_id = $1', [friend.id]);
    for (const w of watches) {
      // Skip a malformed row rather than aborting the whole batch — one bad
      // entry shouldn't wipe out the friend's entire cache for the cycle.
      if (!w || !w.remote_id) continue;
      await client.query(
        `INSERT INTO friend_watches (friend_id, remote_watch_id, payload, watched_at, fetched_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [friend.id, w.remote_id, w, w.watched_at || null]
      );
    }
    await client.query(
      `INSERT INTO friend_profiles (friend_id, stats, now_playing, fetched_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (friend_id) DO UPDATE SET
         stats = EXCLUDED.stats, now_playing = EXCLUDED.now_playing, fetched_at = NOW()`,
      [friend.id, feed.stats || null, JSON.stringify(feed.upcoming || [])]
    );
    // Friends can rename themselves; refresh the cached identity. instance_id
    // is learned here on the first successful pull.
    await client.query(
      `UPDATE friends SET remote_instance_id = COALESCE($2::uuid, remote_instance_id),
              display_name = $3, avatar_url = $4,
              last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
         WHERE id = $1`,
      [
        friend.id,
        feed.instance_id || null,
        feed.display_name || friend.display_name,
        feed.avatar_url || friend.avatar_url,
      ]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    // Unique violation on remote_instance_id: this URL belongs to an instance
    // already stored under another friend row.
    if (err.code === '23505') {
      throw new Error('This URL belongs to a friend you already have');
    }
    throw err;
  } finally {
    client.release();
  }

  return watches.length;
}

// Per-friend in-flight guard, shared by the periodic cron and the live "ping"
// path so the same friend is never synced concurrently (which would race two
// full-replace transactions and let stale data win). Returns 'skipped' when a
// sync for that friend is already running.
const inFlight = new Set();

// Sync one friend, recording the outcome on its row. Every failure is treated
// as transient — stale cache kept, last_error set, polling continues.
async function runSyncFriend(friend) {
  if (inFlight.has(friend.id)) return 'skipped';
  inFlight.add(friend.id);
  try {
    await syncFriend(friend);
    return 'synced';
  } catch (err) {
    await pool.query(
      `UPDATE friends SET last_error = $2, updated_at = NOW() WHERE id = $1`,
      [friend.id, err.message || 'sync failed']
    );
    logger.error({ err, friend_id: friend.id }, 'federation-sync: friend failed');
    return 'failed';
  } finally {
    inFlight.delete(friend.id);
  }
}

let running = false;
async function syncOnce() {
  if (running) {
    logger.info('federation-sync: previous run still in progress, skipping');
    return;
  }
  if (!fed.isEnabled()) return;
  running = true;
  const t0 = Date.now();
  let synced = 0;
  let failed = 0;
  try {
    const { rows } = await pool.query(`SELECT * FROM friends WHERE friend_url IS NOT NULL`);
    for (const friend of rows) {
      const r = await runSyncFriend(friend);
      if (r === 'synced') synced++;
      else if (r === 'failed') failed++;
    }
    await notifyNewMatches().catch((err) => logger.error({ err }, 'together notify'));
    logger.info({ synced, failed, ms: Date.now() - t0 }, 'federation-sync: cycle done');
  } catch (err) {
    logger.error({ err }, 'federation-sync cycle failed');
  } finally {
    running = false;
  }
}

// Sync a single friend immediately — used by the live "ping" path and right
// after the owner pastes a friend's URL.
async function syncFriendById(friendId) {
  if (!fed.isEnabled()) return;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM friends WHERE id = $1 AND friend_url IS NOT NULL`,
      [friendId]
    );
    if (rows[0] && (await runSyncFriend(rows[0])) !== 'skipped') {
      await notifyNewMatches().catch((err) => logger.error({ err }, 'together notify'));
    }
  } catch (err) {
    logger.error({ err, friend_id: friendId }, 'federation-sync: targeted sync failed');
  }
}

let task = null;
function start() {
  if (!fed.isEnabled()) {
    logger.info('federation-sync: FEDERATION_ENABLED not set — skipping');
    return null;
  }
  logger.info(`federation-sync: starting (every ${SYNC_INTERVAL_MIN} minutes)`);
  task = cron.schedule(`*/${SYNC_INTERVAL_MIN} * * * *`, syncOnce);
  setTimeout(syncOnce, 30_000);
  return task;
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, syncOnce, syncFriendById };
