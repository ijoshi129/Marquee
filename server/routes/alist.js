const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');

const router = express.Router();

// GET /api/alist-membership — stored overrides as
// { years: { [year]: bool }, months: { 'YYYY-MM': bool } }. Anything absent
// from both maps defaults to true (assumed A-List); a month override wins over
// its year's flag.
router.get('/', async (req, res) => {
  try {
    const [yearsQ, monthsQ] = await Promise.all([
      pool.query('SELECT year, has_alist FROM alist_membership'),
      pool.query('SELECT year, month, has_alist FROM alist_membership_month'),
    ]);
    const years = {};
    for (const row of yearsQ.rows) years[row.year] = row.has_alist;
    const months = {};
    for (const row of monthsQ.rows) {
      months[`${row.year}-${String(row.month).padStart(2, '0')}`] = row.has_alist;
    }
    res.json({ years, months });
  } catch (err) {
    logger.error({ err }, 'alist-membership list');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/alist-membership/:year — set whether the user had A-List that year.
// A year toggle is authoritative: it also clears any month overrides for that
// year so every month falls back to the new year flag (otherwise a stale month
// override would shadow the year and read as "year on, but this month off").
router.put('/:year', async (req, res) => {
  const year = Number(req.params.year);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return res.status(400).json({ error: 'invalid year' });
  }
  const hasAlist = req.body?.has_alist;
  if (typeof hasAlist !== 'boolean') {
    return res.status(400).json({ error: 'has_alist (boolean) required' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO alist_membership (year, has_alist, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (year) DO UPDATE SET has_alist = EXCLUDED.has_alist, updated_at = NOW()`,
      [year, hasAlist]
    );
    await client.query('DELETE FROM alist_membership_month WHERE year = $1', [year]);
    await client.query('COMMIT');
    res.json({ year, has_alist: hasAlist });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'alist-membership set');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// PUT /api/alist-membership/:year/:month — set whether the user had A-List that
// specific month. Overrides the year-level flag for the month.
router.put('/:year/:month', async (req, res) => {
  const year = Number(req.params.year);
  const month = Number(req.params.month);
  if (!Number.isInteger(year) || year < 1900 || year > 2200) {
    return res.status(400).json({ error: 'invalid year' });
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return res.status(400).json({ error: 'invalid month' });
  }
  const hasAlist = req.body?.has_alist;
  if (typeof hasAlist !== 'boolean') {
    return res.status(400).json({ error: 'has_alist (boolean) required' });
  }
  try {
    await pool.query(
      `INSERT INTO alist_membership_month (year, month, has_alist, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (year, month) DO UPDATE SET has_alist = EXCLUDED.has_alist, updated_at = NOW()`,
      [year, month, hasAlist]
    );
    res.json({ year, month, has_alist: hasAlist });
  } catch (err) {
    logger.error({ err }, 'alist-membership month set');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
