const fs = require('node:fs');
const path = require('node:path');
const logger = require('../logger');
const { pool } = require('../db');

const TRAKT_API_URL = 'https://api.trakt.tv';
const ENV_PATH = path.join(__dirname, '..', '..', '.env');
const USER_AGENT = 'Marquee/0.1 (+https://localhost)';
const MIN_REQUEST_INTERVAL_MS = Math.max(
  parseInt(process.env.TRAKT_MIN_REQUEST_INTERVAL_MS || '5000', 10),
  1000
);
const MAX_RATE_LIMIT_RETRIES = 3;

let nextRequestAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryAfterMs(headers) {
  const retryAfter = headers.get('retry-after');
  if (!retryAfter) return MIN_REQUEST_INTERVAL_MS;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(seconds * 1000, MIN_REQUEST_INTERVAL_MS);

  const dateMs = Date.parse(retryAfter);
  if (Number.isFinite(dateMs)) return Math.max(dateMs - Date.now(), MIN_REQUEST_INTERVAL_MS);

  return MIN_REQUEST_INTERVAL_MS;
}

async function throttle() {
  const waitMs = Math.max(0, nextRequestAt - Date.now());
  if (waitMs > 0) await sleep(waitMs);
  nextRequestAt = Date.now() + MIN_REQUEST_INTERVAL_MS;
}

async function traktFetch(pathname, options, attempt = 0) {
  await throttle();
  const res = await fetch(`${TRAKT_API_URL}${pathname}`, {
    ...options,
    headers: {
      'User-Agent': USER_AGENT,
      ...(options.headers || {}),
    },
  });

  if (res.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return res;

  const waitMs = retryAfterMs(res.headers);
  nextRequestAt = Math.max(nextRequestAt, Date.now() + waitMs);
  logger.warn({ wait_ms: waitMs, path: pathname }, 'trakt: rate limited, waiting before retry');
  await sleep(waitMs);
  return traktFetch(pathname, options, attempt + 1);
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

function escapeEnvValue(value) {
  const s = String(value ?? '');
  if (!s || /^[A-Za-z0-9_./:@+-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function persistEnv(updates) {
  for (const [key, value] of Object.entries(updates)) {
    process.env[key] = String(value);
  }

  try {
    let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
    for (const [key, value] of Object.entries(updates)) {
      const line = `${key}=${escapeEnvValue(value)}`;
      const rx = new RegExp(`^${key}=.*$`, 'm');
      env = rx.test(env) ? env.replace(rx, line) : `${env.replace(/\s*$/, '')}\n${line}\n`;
    }
    fs.writeFileSync(ENV_PATH, env);
  } catch (err) {
    logger.warn({ err }, 'trakt: token refreshed but could not update .env');
  }
}

async function refreshAccessToken() {
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

function hasNotFoundMovies(body) {
  return Array.isArray(body?.not_found?.movies) && body.not_found.movies.length > 0;
}

async function postHistory(row, accessToken) {
  const watchedAt = row.showtime || row.watched_at;
  const payload = {
    movies: [
      {
        ids: { tmdb: Number(row.tmdb_id) },
        watched_at: new Date(watchedAt).toISOString(),
      },
    ],
  };

  return traktFetch('/sync/history', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'trakt-api-version': '2',
      'trakt-api-key': credentials().clientId,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });
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

  const r = await pool.query(
    `SELECT id, title, tmdb_id, showtime, watched_at, status, trakt_synced_at
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
       SET trakt_sync_error = 'Cannot sync to Trakt until this watch has a TMDB id'
       WHERE id = $1`,
      [watchId]
    );
    return { synced: false, skipped: 'missing_tmdb_id' };
  }

  if (!row.showtime && !row.watched_at) {
    await pool.query(
      `UPDATE watches
       SET trakt_sync_error = 'Cannot sync to Trakt without showtime or watched_at'
       WHERE id = $1`,
      [watchId]
    );
    return { synced: false, skipped: 'missing_watch_date' };
  }

  try {
    let res = await postHistory(row, credentials().accessToken);
    if (res.status === 401 && canRefresh()) {
      const token = await refreshAccessToken();
      res = await postHistory(row, token);
    }

    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Trakt sync failed: HTTP ${res.status}${text ? ` ${text}` : ''}`);
    }
    const body = text ? JSON.parse(text) : {};
    if (hasNotFoundMovies(body)) {
      throw new Error(`Trakt could not find TMDB movie id ${row.tmdb_id}`);
    }

    await pool.query(
      `UPDATE watches
       SET trakt_synced_at = NOW(),
           trakt_sync_error = NULL
       WHERE id = $1`,
      [watchId]
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
}

module.exports = {
  isConfigured,
  queueWatch,
  syncWatch,
};
