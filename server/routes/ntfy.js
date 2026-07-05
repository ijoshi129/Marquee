// Owner-facing ntfy configuration. Sits behind the owner lock like the rest of
// the owner surface; the stored token is the owner's own secret, so it's safe
// to echo back to them.

const express = require('express');
const logger = require('../logger');
const ntfy = require('../services/ntfy');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.json(await ntfy.getSettings());
  } catch (err) {
    logger.error({ err }, 'get ntfy settings');
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/', async (req, res) => {
  try {
    res.json(await ntfy.updateSettings(req.body || {}));
  } catch (err) {
    logger.error({ err }, 'update ntfy settings');
    res.status(500).json({ error: 'Server error' });
  }
});

// Test with the values in the request body (not the saved ones), so the owner
// can verify before hitting Save.
router.post('/test', async (req, res) => {
  try {
    await ntfy.sendTest(req.body || {});
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message || 'Test failed' });
  }
});

module.exports = router;
