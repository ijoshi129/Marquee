const crypto = require('node:crypto');

// Single owner passcode protecting everything except the friend-facing
// federation API (which carries its own per-friend tokens). When OWNER_PASSCODE
// is unset the lock is disabled and the app behaves as before — so existing
// single-user deployments are unaffected until the owner opts in. Set it before
// sharing your instance with friends.

function passcodeSet() {
  return !!process.env.OWNER_PASSCODE;
}

function verifyPasscode(supplied) {
  const expected = process.env.OWNER_PASSCODE;
  if (!expected || typeof supplied !== 'string') return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireOwner(req, res, next) {
  if (!passcodeSet()) return next();
  const supplied = req.get('x-owner-passcode');
  if (verifyPasscode(supplied)) return next();
  return res.status(401).json({ error: 'Locked', locked: true });
}

module.exports = { passcodeSet, verifyPasscode, requireOwner };
