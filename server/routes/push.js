const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');

const router = express.Router();

// GET /api/push/key — the VAPID public key the client needs to subscribe.
// Returns enabled:false when push isn't configured so the client can hide the UI.
router.get('/key', (req, res) => {
  res.json({ enabled: !!process.env.VAPID_PUBLIC_KEY, key: process.env.VAPID_PUBLIC_KEY || null });
});

// POST /api/push/subscribe — store a device's push subscription.
router.post('/subscribe', async (req, res) => {
  try {
    const sub = req.body || {};
    if (!sub.endpoint || !sub.keys?.p256dh || !sub.keys?.auth) {
      return res.status(400).json({ error: 'Invalid subscription' });
    }
    await pool.query(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth)
       VALUES ($1, $2, $3)
       ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [sub.endpoint, sub.keys.p256dh, sub.keys.auth]
    );
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'push subscribe');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/push/unsubscribe — remove a device's subscription.
router.post('/unsubscribe', async (req, res) => {
  try {
    const { endpoint } = req.body || {};
    if (endpoint) await pool.query('DELETE FROM push_subscriptions WHERE endpoint = $1', [endpoint]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'push unsubscribe');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
