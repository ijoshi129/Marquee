const crypto = require('node:crypto');
const { pool } = require('../db');

// 256-bit URL-safe secret, used for both pairing codes and per-friend tokens.
function generateSecret() {
  return crypto.randomBytes(32).toString('base64url');
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Constant-time compare of two hex digests. Lengths are fixed (sha256), but
// timingSafeEqual still throws on mismatched lengths, so guard for safety.
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// Seed this instance's identity once. display_name comes from env on first
// boot; later edits live in the row and aren't overwritten.
async function ensureIdentity() {
  const name = process.env.INSTANCE_NAME || 'Marquee';
  await pool.query(
    `INSERT INTO federation_identity (id, display_name)
     VALUES (TRUE, $1)
     ON CONFLICT (id) DO NOTHING`,
    [name]
  );
  return getIdentity();
}

async function getIdentity() {
  const { rows } = await pool.query(`SELECT * FROM federation_identity WHERE id = TRUE`);
  return rows[0] || null;
}

async function ensureSettings() {
  await pool.query(
    `INSERT INTO federation_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`
  );
  return getSettings();
}

async function getSettings() {
  const { rows } = await pool.query(`SELECT * FROM federation_settings WHERE id = TRUE`);
  return rows[0] || null;
}

// Federation is "on" once the owner has set up an instance name. Used to
// fail-closed the friend-facing API and to no-op the sync worker otherwise.
function isEnabled() {
  return process.env.FEDERATION_ENABLED === '1' || process.env.FEDERATION_ENABLED === 'true';
}

// A friend's base_url is fetched server-side with our outbound token attached,
// so a peer-supplied value is an SSRF / token-exfiltration vector. We can't ban
// private addresses (friends legitimately live on localhost / LAN / Tailscale),
// but we can require a sane http(s) URL and block the link-local range that
// cloud metadata services sit on (169.254.0.0/16, e.g. 169.254.169.254). Returns
// the normalized origin string, or null if the URL is unacceptable.
function safeBaseUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  if (host === '0.0.0.0' || host === '[::]' || host === '::') return null;
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(host)) return null; // link-local / metadata
  if (/^fe80:/i.test(host)) return null; // IPv6 link-local
  return url.origin;
}

const PING_DEBOUNCE_MS = 400;
const PING_TIMEOUT_MS = 5000;
let pingTimer = null;

async function pingFriend(friend) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PING_TIMEOUT_MS);
  try {
    await fetch(`${friend.base_url.replace(/\/$/, '')}/api/federation/ping`, {
      method: 'POST',
      headers: { authorization: `Bearer ${friend.outbound_token}` },
      signal: controller.signal,
    });
  } catch {
    // Best-effort liveness; the periodic poll is the backstop.
  } finally {
    clearTimeout(timer);
  }
}

// Tell every active friend "I changed — pull me now", debounced so a burst of
// edits collapses into one round of pings. Fire-and-forget; safe to call often.
function notifyFriends() {
  if (!isEnabled() || pingTimer) return;
  pingTimer = setTimeout(async () => {
    pingTimer = null;
    try {
      const { rows } = await pool.query(
        `SELECT base_url, outbound_token FROM friends WHERE status = 'active'`
      );
      await Promise.allSettled(rows.map((f) => pingFriend(f)));
    } catch {
      // ignore — the backstop poll will catch up
    }
  }, PING_DEBOUNCE_MS);
}

module.exports = {
  generateSecret,
  sha256,
  safeEqualHex,
  ensureIdentity,
  getIdentity,
  ensureSettings,
  getSettings,
  isEnabled,
  safeBaseUrl,
  notifyFriends,
};
