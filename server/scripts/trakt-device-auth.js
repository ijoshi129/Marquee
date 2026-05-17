#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');
const CREDS_PATH = path.join(ROOT, 'trakt_creds.txt');
const API_URL = 'https://api.trakt.tv';
const USER_AGENT = 'Marquee/0.1 (+https://localhost)';
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

async function traktFetch(pathname, options) {
  while (true) {
    await throttle();
    const res = await fetch(`${API_URL}${pathname}`, {
      ...options,
      headers: {
        'User-Agent': USER_AGENT,
        ...(options.headers || {}),
      },
    });
    if (res.status !== 429) return res;

    const waitMs = retryAfterMs(res.headers);
    nextRequestAt = Math.max(nextRequestAt, Date.now() + waitMs);
    console.log(`Trakt rate limited this request. Waiting ${Math.ceil(waitMs / 1000)}s before retrying...`);
    await sleep(waitMs);
  }
}

function parseCredFile() {
  if (!fs.existsSync(CREDS_PATH)) return {};
  const text = fs.readFileSync(CREDS_PATH, 'utf8');
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_-]+)\s*[:=]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].replace(/^['"]|['"]$/g, '');
    if (key === 'client_id') out.TRAKT_CLIENT_ID = value;
    if (key === 'client_secret') out.TRAKT_CLIENT_SECRET = value;
  }
  return out;
}

function escapeEnvValue(value) {
  const s = String(value ?? '');
  if (!s || /^[A-Za-z0-9_./:@+-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

function writeEnv(updates) {
  let env = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') continue;
    process.env[key] = String(value);
    const line = `${key}=${escapeEnvValue(value)}`;
    const rx = new RegExp(`^${key}=.*$`, 'm');
    env = rx.test(env) ? env.replace(rx, line) : `${env.replace(/\s*$/, '')}\n${line}\n`;
  }
  fs.writeFileSync(ENV_PATH, env);
}

async function post(pathname, body) {
  const res = await traktFetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  const parsed = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${text ? ` ${text}` : ''}`);
  }
  return parsed;
}

async function main() {
  writeEnv({
    TRAKT_REDIRECT_URI: process.env.TRAKT_REDIRECT_URI || 'http://localhost:3000',
    ...parseCredFile(),
  });

  const clientId = process.env.TRAKT_CLIENT_ID;
  const clientSecret = process.env.TRAKT_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('TRAKT_CLIENT_ID and TRAKT_CLIENT_SECRET are required in .env or trakt_creds.txt');
  }

  const code = await post('/oauth/device/code', { client_id: clientId });
  console.log('\nAuthorize Marquee with Trakt:');
  console.log(`  1. Open: ${code.verification_url}`);
  console.log(`  2. Enter code: ${code.user_code}`);
  console.log('\nWaiting for approval...\n');

  const deadline = Date.now() + code.expires_in * 1000;
  const interval = Math.max(code.interval || 5, 5) * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    let res;
    try {
      res = await traktFetch('/oauth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: code.device_code,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      });
    } catch {
      continue;
    }

    if (res.status === 400 || res.status === 404 || res.status === 409) {
      continue;
    }

    const text = await res.text();
    if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status}${text ? ` ${text}` : ''}`);
    const token = text ? JSON.parse(text) : {};
    writeEnv({
      TRAKT_ACCESS_TOKEN: token.access_token,
      TRAKT_REFRESH_TOKEN: token.refresh_token,
      TRAKT_TOKEN_EXPIRES_AT: String((token.created_at + token.expires_in) * 1000),
    });
    console.log('Trakt tokens written to .env');
    return;
  }

  throw new Error('Trakt authorization expired before approval');
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
