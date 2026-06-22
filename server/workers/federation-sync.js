// Pulls each active friend's shared data on an interval and caches it locally so
// the Friends UI is fast and survives a friend being offline. Polls the friend's
// federation API presenting our outbound token; one friend failing never blocks
// the others. Transient failures keep the friend active and leave the stale
// cache in place — only a 401 means we've been revoked.

const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');
const fed = require('../services/federation');

const SYNC_INTERVAL_MIN = parseInt(process.env.FEDERATION_SYNC_INTERVAL_MIN, 10) || 15;
const REQUEST_TIMEOUT_MS = 10_000;

async function fetchJson(base, path, token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base.replace(/\/$/, '')}${path}`, {
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (resp.status === 401) {
      const err = new Error('unauthorized');
      err.unauthorized = true;
      throw err;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function syncFriend(friend) {
  const profile = await fetchJson(friend.base_url, '/api/federation/profile', friend.outbound_token);
  const activity = await fetchJson(friend.base_url, '/api/federation/activity', friend.outbound_token);

  // Full replace, not incremental: re-pulling the whole shared set is what makes
  // edits propagate — a re-rated film updates, and a film the friend marked
  // private (or deleted) disappears from our cache. Cheap at personal scale.
  const watches = Array.isArray(activity.watches) ? activity.watches : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM friend_watches WHERE friend_id = $1', [friend.id]);
    for (const w of watches) {
      await client.query(
        `INSERT INTO friend_watches (friend_id, remote_watch_id, payload, watched_at, fetched_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        [friend.id, w.remote_id, w, w.watched_at || null]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await pool.query(
    `INSERT INTO friend_profiles (friend_id, stats, now_playing, fetched_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (friend_id) DO UPDATE SET
       stats = EXCLUDED.stats, now_playing = EXCLUDED.now_playing, fetched_at = NOW()`,
    [friend.id, profile.stats || null, JSON.stringify(profile.upcoming || [])]
  );

  // Friends can rename themselves; refresh the cached identity.
  await pool.query(
    `UPDATE friends SET display_name = $2, avatar_url = $3,
            last_synced_at = NOW(), last_error = NULL, updated_at = NOW()
       WHERE id = $1`,
    [friend.id, profile.display_name || friend.display_name, profile.avatar_url || friend.avatar_url]
  );

  return watches.length;
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
    const { rows } = await pool.query(`SELECT * FROM friends WHERE status = 'active'`);
    for (const friend of rows) {
      try {
        await syncFriend(friend);
        synced++;
      } catch (err) {
        failed++;
        if (err.unauthorized) {
          await pool.query(
            `UPDATE friends SET status = 'revoked', last_error = 'Revoked by friend', updated_at = NOW() WHERE id = $1`,
            [friend.id]
          );
          logger.warn({ friend_id: friend.id }, 'federation-sync: friend revoked us');
        } else {
          await pool.query(
            `UPDATE friends SET last_error = $2, updated_at = NOW() WHERE id = $1`,
            [friend.id, err.message || 'sync failed']
          );
          logger.error({ err, friend_id: friend.id }, 'federation-sync: friend failed');
        }
      }
    }
    logger.info({ synced, failed, ms: Date.now() - t0 }, 'federation-sync: cycle done');
  } catch (err) {
    logger.error({ err }, 'federation-sync cycle failed');
  } finally {
    running = false;
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

module.exports = { start, stop, syncOnce };
