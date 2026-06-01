const path = require('node:path');
const logger = require('../logger');
const { pool } = require('../db');
const { traktFetch: httpFetch, writeEnvFile } = require('./trakt-http');

const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const CAPTURE_HISTORY_WINDOW_MS = 1000;
const DUPLICATE_HISTORY_WINDOW_MS = 5 * 60 * 60 * 1000;

// Watches currently being pushed to Trakt in this process. The inline sync (on
// create / patch / thank-you ingest) and the background worker can both reach
// for the same watch; this guard stops them posting a duplicate play.
const inFlight = new Set();

// Dedupes concurrent token refreshes. Trakt rotates the refresh token on every
// use, so two refreshes racing would leave one of them holding a stale token.
let refreshPromise = null;

function traktFetch(pathname, options) {
  return httpFetch(pathname, options, {
    maxRateLimitRetries: 3,
    onRateLimit: (waitMs, p) =>
      logger.warn({ wait_ms: waitMs, path: p }, 'trakt: rate limited, waiting before retry'),
  });
}

function credentials() {
  return {
    clientId: process.env.TRAKT_CLIENT_ID || '',
    clientSecret: process.env.TRAKT_CLIENT_SECRET || '',
    accessToken: process.env.TRAKT_ACCESS_TOKEN || '',
    refreshToken: process.env.TRAKT_REFRESH_TOKEN || '',
    redirectUri: process.env.TRAKT_REDIRECT_URI || '',
  };
}

function isConfigured() {
  const c = credentials();
  return Boolean(c.clientId && c.accessToken);
}

function canRefresh() {
  const c = credentials();
  return Boolean(c.clientId && c.clientSecret && c.refreshToken && c.redirectUri);
}

function persistEnv(updates) {
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = String(value);
  }
  try {
    writeEnvFile(ENV_PATH, updates);
  } catch (err) {
    logger.warn({ err }, 'trakt: token refreshed but could not update .env');
  }
}

async function doRefreshAccessToken() {
  if (!canRefresh()) {
    throw new Error('Trakt access token expired and refresh credentials are incomplete');
  }

  const c = credentials();
  const res = await traktFetch('/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      refresh_token: c.refreshToken,
      client_id: c.clientId,
      client_secret: c.clientSecret,
      redirect_uri: c.redirectUri,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Trakt token refresh failed: HTTP ${res.status}${body ? ` ${body}` : ''}`);
  }

  const token = await res.json();
  persistEnv({
    TRAKT_ACCESS_TOKEN: token.access_token,
    TRAKT_REFRESH_TOKEN: token.refresh_token,
    TRAKT_TOKEN_EXPIRES_AT: String((token.created_at + token.expires_in) * 1000),
  });
  logger.info('trakt: refreshed access token');
  return token.access_token;
}

function refreshAccessToken() {
  if (!refreshPromise) {
    refreshPromise = doRefreshAccessToken().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

function authHeaders(accessToken) {
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': credentials().clientId,
    Authorization: `Bearer ${accessToken}`,
  };
}

function hasNotFoundMovies(body) {
  return Array.isArray(body?.not_found?.movies) && body.not_found.movies.length > 0;
}

function postHistory(tmdbId, watchedAtIso, accessToken) {
  return traktFetch('/sync/history', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({
      movies: [{ ids: { tmdb: Number(tmdbId) }, watched_at: watchedAtIso }],
    }),
  });
}

function removeHistory(historyId, accessToken) {
  return traktFetch('/sync/history/remove', {
    method: 'POST',
    headers: authHeaders(accessToken),
    body: JSON.stringify({ ids: [historyId] }),
  });
}

// Find a movie play around the watched_at timestamp Marquee is about to send.
// Preflight lookups use a wider window to avoid duplicate backfills; post-write
// capture uses a tight window because Trakt's /sync/history response doesn't
// include the created play id.
async function findHistoryId(tmdbId, watchedAtIso, accessToken, opts = {}) {
  try {
    const watchedAtMs = Date.parse(watchedAtIso);
    const windowMs = opts.windowMs ?? CAPTURE_HISTORY_WINDOW_MS;
    const halfWindowMs = Math.floor(windowMs / 2);
    const startAt = new Date(watchedAtMs - halfWindowMs).toISOString();
    const endAt = new Date(watchedAtMs + halfWindowMs).toISOString();
    const start = encodeURIComponent(startAt);
    const end = encodeURIComponent(endAt);
    const res = await traktFetch(`/sync/history/movies?start_at=${start}&end_at=${end}`, {
      headers: authHeaders(accessToken),
    });
    if (res.status === 401 && opts.throwUnauthorized) {
      const err = new Error('Trakt history lookup unauthorized');
      err.status = 401;
      throw err;
    }
    if (!res.ok) {
      if (opts.strict) {
        const body = await res.text().catch(() => '');
        throw new Error(`Trakt history lookup failed: HTTP ${res.status}${body ? ` ${body}` : ''}`);
      }
      return null;
    }

    let items = null;
    try {
      items = await res.json();
    } catch (err) {
      if (opts.strict) throw new Error(`Trakt history lookup returned invalid JSON: ${err.message}`);
    }
    if (!Array.isArray(items)) {
      if (opts.strict) throw new Error('Trakt history lookup returned an unexpected response');
      return null;
    }
    const match = items.find((it) => Number(it?.movie?.ids?.tmdb) === Number(tmdbId));
    return match?.id ?? null;
  } catch (err) {
    if (err.status === 401 && opts.throwUnauthorized) throw err;
    if (opts.strict) throw err;
    return null;
  }
}

async function queueWatch(watchId, opts = {}) {
  const setSynced = opts.resync ? ', trakt_synced_at = NULL' : '';
  await pool.query(
    `UPDATE watches
     SET trakt_sync_requested_at = COALESCE(trakt_sync_requested_at, NOW()),
         trakt_sync_error = NULL
         ${setSynced}
     WHERE id = $1`,
    [watchId]
  );

  if (!isConfigured()) return { queued: true, skipped: 'not_configured' };
  return syncWatch(watchId);
}

async function syncWatch(watchId) {
  if (!isConfigured()) return { synced: false, skipped: 'not_configured' };
  if (inFlight.has(watchId)) return { synced: false, skipped: 'in_flight' };

  inFlight.add(watchId);
  try {
    const r = await pool.query(
      `SELECT id, title, tmdb_id, showtime, watched_at, status,
              trakt_synced_at, trakt_history_id
       FROM watches
       WHERE id = $1`,
      [watchId]
    );
    if (!r.rows.length) return { synced: false, skipped: 'not_found' };

    const row = r.rows[0];
    if (row.status !== 'watched') return { synced: false, skipped: 'not_watched' };
    if (row.trakt_synced_at) return { synced: true, skipped: 'already_synced' };

    if (!row.tmdb_id) {
      await pool.query(
        `UPDATE watches
         SET trakt_sync_error = 'Cannot sync to Trakt until this watch has a TMDB id',
             trakt_sync_attempts = trakt_sync_attempts + 1
         WHERE id = $1`,
        [watchId]
      );
      return { synced: false, skipped: 'missing_tmdb_id' };
    }

    if (!row.showtime && !row.watched_at) {
      await pool.query(
        `UPDATE watches
         SET trakt_sync_error = 'Cannot sync to Trakt without showtime or watched_at',
             trakt_sync_attempts = trakt_sync_attempts + 1
         WHERE id = $1`,
        [watchId]
      );
      return { synced: false, skipped: 'missing_watch_date' };
    }

    const watchedAtIso = new Date(row.showtime || row.watched_at).toISOString();

    try {
      let token = credentials().accessToken;

      // A leftover history id with no trakt_synced_at means this is a resync —
      // the watch's date or TMDB id changed. Drop the stale play before
      // re-adding so Trakt doesn't accumulate a duplicate.
      if (row.trakt_history_id) {
        let rm = await removeHistory(row.trakt_history_id, token);
        if (rm.status === 401 && canRefresh()) {
          token = await refreshAccessToken();
          rm = await removeHistory(row.trakt_history_id, token);
        }
        if (!rm.ok) {
          const t = await rm.text().catch(() => '');
          throw new Error(
            `Trakt could not remove the previous history entry: HTTP ${rm.status}${t ? ` ${t}` : ''}`
          );
        }
      }

      let existingHistoryId;
      try {
        existingHistoryId = await findHistoryId(row.tmdb_id, watchedAtIso, token, {
          strict: true,
          throwUnauthorized: true,
          windowMs: DUPLICATE_HISTORY_WINDOW_MS,
        });
      } catch (err) {
        if (err.status !== 401 || !canRefresh()) throw err;
        token = await refreshAccessToken();
        existingHistoryId = await findHistoryId(row.tmdb_id, watchedAtIso, token, {
          strict: true,
          throwUnauthorized: true,
          windowMs: DUPLICATE_HISTORY_WINDOW_MS,
        });
      }
      if (existingHistoryId != null) {
        await pool.query(
          `UPDATE watches
           SET trakt_synced_at = NOW(),
               trakt_sync_error = NULL,
               trakt_history_id = $2
           WHERE id = $1`,
          [watchId, existingHistoryId]
        );
        logger.info(
          { watch_id: watchId, tmdb_id: row.tmdb_id, trakt_history_id: existingHistoryId },
          'trakt: matching history entry already exists, marking synced'
        );
        return { synced: true, skipped: 'already_on_trakt' };
      }

      let res = await postHistory(row.tmdb_id, watchedAtIso, token);
      if (res.status === 401 && canRefresh()) {
        token = await refreshAccessToken();
        res = await postHistory(row.tmdb_id, watchedAtIso, token);
      }

      const text = await res.text();
      if (!res.ok) {
        throw new Error(`Trakt sync failed: HTTP ${res.status}${text ? ` ${text}` : ''}`);
      }
      const body = text ? JSON.parse(text) : {};
      if (hasNotFoundMovies(body)) {
        throw new Error(`Trakt could not find TMDB movie id ${row.tmdb_id}`);
      }

      const historyId = await findHistoryId(row.tmdb_id, watchedAtIso, token);
      if (historyId == null) {
        logger.warn(
          { watch_id: watchId, tmdb_id: row.tmdb_id },
          'trakt: synced but could not capture history id (a future resync may duplicate)'
        );
      }

      await pool.query(
        `UPDATE watches
         SET trakt_synced_at = NOW(),
             trakt_sync_error = NULL,
             trakt_history_id = $2
         WHERE id = $1`,
        [watchId, historyId]
      );
      logger.info({ watch_id: watchId, tmdb_id: row.tmdb_id }, 'trakt: watch synced');
      return { synced: true };
    } catch (err) {
      await pool.query(
        `UPDATE watches
         SET trakt_sync_attempts = trakt_sync_attempts + 1,
             trakt_sync_error = $2
         WHERE id = $1`,
        [watchId, err.message]
      );
      logger.error({ err, watch_id: watchId }, 'trakt: sync failed');
      return { synced: false, error: err.message };
    }
  } finally {
    inFlight.delete(watchId);
  }
}

module.exports = {
  isConfigured,
  queueWatch,
  syncWatch,
};
