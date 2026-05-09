const express = require('express');
const logger = require('../logger');
const { searchTheaters } = require('../services/theaters');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const rows = await searchTheaters((req.query.q || '').toString());
    res.json(rows);
  } catch (err) {
    logger.error({ err: err }, 'theaters search');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
