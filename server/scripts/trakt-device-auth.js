#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const fs = require('node:fs');
const path = require('node:path');
const { sleep, traktFetch: httpFetch, writeEnvFile } = require('../services/trakt-http');

const ROOT = path.join(__dirname, '..', '..');
const ENV_PATH = path.join(ROOT, '.env');
const CREDS_PATH = path.join(ROOT, 'trakt_creds.txt');

// Trakt device-token poll responses: 400 means the user hasn't approved yet;
// every other status is terminal. https://trakt.docs.apiary.io
const POLL_FAILURES = {
  404: 'device code not found — restart the script',
  409: 'this code was already approved — restart the script',
  410: 'the code expired before approval — restart the script',
  418: 'authorization was denied — restart the script to try again',
};

function traktFetch(pathname, options) {
  return httpFetch(pathname, options, {
    maxRateLimitRetries: Infinity,
    onRateLimit: (waitMs) =>
      console.log(`Trakt rate limited this request. Waiting ${Math.ceil(waitMs / 1000)}s before retrying...`),
  });
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

function writeEnv(updates) {
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null || value === '') continue;
    process.env[key] = String(value);
  }
  writeEnvFile(ENV_PATH, updates);
}

async function post(pathname, body) {
  const res = await traktFetch(pathname, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}${text ? ` ${text}` : ''}`);
  }
  return text ? JSON.parse(text) : null;
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

    if (res.status === 400) continue;

    const text = await res.text();
    if (!res.ok) {
      const reason = POLL_FAILURES[res.status];
      throw new Error(
        reason
          ? `Trakt authorization failed: ${reason}`
          : `Token exchange failed: HTTP ${res.status}${text ? ` ${text}` : ''}`
      );
    }

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
