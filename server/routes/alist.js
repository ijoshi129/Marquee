const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');

const router = express.Router();

// GET /api/alist-membership — the stored per-year overrides as { year: bool }.
// Years absent from the map default to true (assumed A-List) on the client.
router.get('/', async (req, res) => {
  try {
    const r = await pool.query('SELECT year, has_alist FROM alist_membership');
    const map = {};
    for (const row of r.rows) map[row.year] = row.has_alist;
    res.json(map);
  } catch (err) {
    logger.error({ err }, 'alist-membership list');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/alist-membership/:year — set whether the user had A-List that year.
router.put('/:year', async (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return res.status(400).json({ error: 'invalid year' });
  }
  const hasAlist = req.body?.has_alist;
  if (typeof hasAlist !== 'boolean') {
    return res.status(400).json({ error: 'has_alist (boolean) required' });
  }
  try {
    await pool.query(
      `INSERT INTO alist_membership (year, has_alist, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (year) DO UPDATE SET has_alist = EXCLUDED.has_alist, updated_at = NOW()`,
      [year, hasAlist]
    );
    res.json({ year, has_alist: hasAlist });
  } catch (err) {
    logger.error({ err }, 'alist-membership set');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
