// Friends over Tailcat: a second way to reach a friend, beside the plain web
// URL, for instances with no public address. The tunnel itself lives in the
// marquee-tailcat helper (built from /tailcat), which this module starts and
// keeps running. Its identity is kept in app_state so the address survives
// restarts, backups and moving hosts.

const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { pool } = require('../db');
const logger = require('../logger');
const jobStatus = require('./job-status');

const STATE_KEY = 'tailcat_identity';
const SCHEME = 'tailcat:';
const ADDR_RX = /^tc[A-Za-z0-9_-]{20,1000}$/;
const RESTART_MIN_MS = 15_000;
const RESTART_MAX_MS = 10 * 60_000;

let child = null;
let address = null;
let relay = null;
let stopping = false;
let restartTimer = null;
let restartDelay = RESTART_MIN_MS;

function isEnabled() {
  const v = process.env.TAILCAT_ENABLED;
  return v === '1' || v === 'true';
}

function proxyPort() {
  return Number(process.env.TAILCAT_PROXY_PORT) || 3100;
}

function binPath() {
  return process.env.TAILCAT_BIN || 'marquee-tailcat';
}

function myAddress() {
  return address;
}

function relayName() {
  return relay;
}

function isTailcatUrl(raw) {
  return typeof raw === 'string' && raw.startsWith(`${SCHEME}//`);
}

function myUrlFor(token) {
  return address ? `${SCHEME}//${address}/api/federation/${token}` : null;
}

// tailcat://<address>/api/federation/<token>/feed → the helper's loopback proxy.
function proxiedUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== SCHEME) throw new Error('not a tailcat URL');
  if (!ADDR_RX.test(url.host)) throw new Error('bad tailcat address');
  if (!isEnabled()) throw new Error('Tailcat is not turned on here (TAILCAT_ENABLED)');
  if (!child || !address) throw new Error('Tailcat is not running yet');
  return `http://127.0.0.1:${proxyPort()}/peer/${url.host}${url.pathname}${url.search}`;
}

async function loadIdentity() {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [STATE_KEY]);
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return null;
  }
}

async function saveIdentity(identity) {
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [STATE_KEY, JSON.stringify(identity)]
  );
}

function scheduleRestart() {
  if (stopping || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    launch().catch((err) => logger.error({ err }, 'tailcat: restart failed'));
  }, restartDelay);
  restartTimer.unref();
  restartDelay = Math.min(restartDelay * 2, RESTART_MAX_MS);
}

async function launch() {
  const identity = await loadIdentity();
  const config = {
    key: identity ? identity.key : '',
    psk: identity ? identity.psk : '',
    region: identity ? identity.region : null,
    upstream: `http://127.0.0.1:${process.env.PORT || 3000}`,
    proxy: `127.0.0.1:${proxyPort()}`,
    debug: process.env.TAILCAT_DEBUG === '1',
  };

  let proc;
  try {
    proc = spawn(binPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    await jobStatus.failed('tailcat', err);
    return scheduleRestart();
  }
  child = proc;
  let lastError = null;

  proc.on('error', (err) => {
    lastError = err;
  });
  proc.stdin.end(JSON.stringify(config) + '\n');

  readline.createInterface({ input: proc.stderr }).on('line', (line) => {
    logger.debug(line);
  });
  readline.createInterface({ input: proc.stdout }).on('line', async (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.event === 'identity') {
      try {
        await saveIdentity({ key: msg.key, psk: msg.psk, region: msg.region });
        logger.info('tailcat: new identity saved');
      } catch (err) {
        logger.error({ err }, 'tailcat: could not save identity');
      }
    } else if (msg.event === 'ready') {
      address = msg.address;
      relay = msg.relay || null;
      restartDelay = RESTART_MIN_MS;
      logger.info({ relay }, 'tailcat: ready');
      await jobStatus.succeeded('tailcat', { relay });
    } else if (msg.event === 'error') {
      lastError = new Error(msg.message);
    }
  });

  proc.on('close', async (code) => {
    if (child === proc) {
      child = null;
      address = null;
    }
    if (stopping) return;
    const err = lastError || new Error(`helper exited with code ${code}`);
    logger.error(`tailcat: ${err.message}`);
    await jobStatus.failed('tailcat', err);
    scheduleRestart();
  });
}

async function start() {
  if (!isEnabled()) return;
  stopping = false;
  await jobStatus.watch('tailcat');
  await launch();
}

function stop() {
  stopping = true;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = null;
  if (child) child.kill();
}

module.exports = {
  isEnabled,
  isTailcatUrl,
  myAddress,
  myUrlFor,
  proxiedUrl,
  relayName,
  start,
  stop,
  ADDR_RX,
};
