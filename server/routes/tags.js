// GET /api/tags — all distinct tags currently in use, sorted by usage count
// then name. Drives the tag filter rail and the chip-editor autocomplete.

const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT tag AS name, COUNT(*)::int AS count
       FROM watches, unnest(tags) AS tag
       GROUP BY tag
       ORDER BY count DESC, name ASC`
    );
    res.json(r.rows);
  } catch (err) {
    logger.error({ err }, 'tags list');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
