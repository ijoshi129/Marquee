const fs = require('node:fs');

const TRAKT_API_URL = 'https://api.trakt.tv';

let appVersion = '0.0.0';
try {
  appVersion = require('../package.json').version || appVersion;
} catch {
  /* keep the default */
}
const USER_AGENT = `Marquee/${appVersion} (+https://localhost)`;

const MIN_REQUEST_INTERVAL_MS = Math.max(
  parseInt(process.env.TRAKT_MIN_REQUEST_INTERVAL_MS || '5000', 10),
  1000
);

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

// One client-side rate limiter shared by every Trakt request in this process.
// On HTTP 429 it honours Retry-After and retries up to maxRateLimitRetries
// times (pass Infinity for the interactive auth script).
async function traktFetch(pathname, options = {}, { maxRateLimitRetries = 3, onRateLimit } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    await throttle();
    const res = await fetch(`${TRAKT_API_URL}${pathname}`, {
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        ...(options.headers || {}),
      },
    });

    if (res.status !== 429 || attempt >= maxRateLimitRetries) return res;

    const waitMs = retryAfterMs(res.headers);
    nextRequestAt = Math.max(nextRequestAt, Date.now() + waitMs);
    if (onRateLimit) onRateLimit(waitMs, pathname);
    await sleep(waitMs);
  }
}

function escapeEnvValue(value) {
  const s = String(value ?? '');
  if (!s || /^[A-Za-z0-9_./:@+-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

// Upsert KEY=value lines into an env file, leaving every other line intact.
// Empty values are skipped so a missing token never blanks an existing line.
function writeEnvFile(envPath, updates) {
  let env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') continue;
    const line = `${key}=${escapeEnvValue(value)}`;
    const rx = new RegExp(`^${key}=.*$`, 'm');
    env = rx.test(env) ? env.replace(rx, line) : `${env.replace(/\s*$/, '')}\n${line}\n`;
  }
  fs.writeFileSync(envPath, env);
}

module.exports = {
  TRAKT_API_URL,
  USER_AGENT,
  MIN_REQUEST_INTERVAL_MS,
  sleep,
  retryAfterMs,
  throttle,
  traktFetch,
  escapeEnvValue,
  writeEnvFile,
};
