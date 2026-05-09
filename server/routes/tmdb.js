const express = require('express');
const logger = require('../logger');
const tmdb = require('../services/tmdb');

const router = express.Router();

router.get('/search', async (req, res) => {
  try {
    const q = (req.query.q || '').toString();
    if (!q.trim()) return res.json([]);
    const results = await tmdb.search(q);
    results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
    res.json(results.slice(0, 10));
  } catch (err) {
    logger.error({ err: err }, 'tmdb search');
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;
