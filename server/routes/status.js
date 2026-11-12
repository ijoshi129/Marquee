// Owner-facing health of the background jobs. Unlike /api/health, which only
// says the process and database are up, this says whether the work is getting
// done.

const express = require('express');
const logger = require('../logger');
const status = require('../services/status');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    res.json(await status.report());
  } catch (err) {
    logger.error({ err }, 'status report');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
