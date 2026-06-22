const express = require('express');
const { passcodeSet, verifyPasscode } = require('../middleware/owner-auth');

const router = express.Router();

// Whether the lock is on, and whether the passcode the client already holds is
// valid — lets the app decide on load if it needs to show the unlock screen.
router.get('/status', (req, res) => {
  const required = passcodeSet();
  res.json({
    required,
    unlocked: !required || verifyPasscode(req.get('x-owner-passcode')),
  });
});

// Verify a passcode the user just typed. The client stores it on success and
// sends it as X-Owner-Passcode on every subsequent request.
router.post('/unlock', (req, res) => {
  if (!passcodeSet()) return res.json({ ok: true });
  if (verifyPasscode((req.body || {}).passcode)) return res.json({ ok: true });
  res.status(401).json({ error: 'Incorrect passcode' });
});

module.exports = router;
