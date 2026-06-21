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

// Seed this instance's identity once. display_name/handle come from env on
// first boot; later edits live in the row and aren't overwritten.
async function ensureIdentity() {
  const name = process.env.INSTANCE_NAME || 'Marquee';
  const handle = process.env.INSTANCE_HANDLE || null;
  await pool.query(
    `INSERT INTO federation_identity (id, display_name, handle)
     VALUES (TRUE, $1, $2)
     ON CONFLICT (id) DO NOTHING`,
    [name, handle]
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

module.exports = {
  generateSecret,
  sha256,
  safeEqualHex,
  ensureIdentity,
  getIdentity,
  ensureSettings,
  getSettings,
  isEnabled,
};
