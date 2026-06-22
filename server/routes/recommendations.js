const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');
const tmdb = require('../services/tmdb');

const router = express.Router();

// GET /api/recommendations — pending recommendations, with poster from cache.
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT r.id, r.from_name, r.tmdb_id, r.title, r.created_at,
              tc.payload->>'poster_url' AS poster_url,
              tc.payload->>'release_year' AS release_year
         FROM recommendations r
         LEFT JOIN tmdb_cache tc ON tc.tmdb_id = r.tmdb_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'list recommendations');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/recommendations/:id/add — add the film to the watchlist, mark added.
router.post('/:id/add', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tmdb_id, title, from_name FROM recommendations WHERE id = $1`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const { tmdb_id, title, from_name } = rows[0];
    if (tmdb_id) {
      try {
        const d = await tmdb.getOrFetchDetails(tmdb_id);
        await pool.query(
          `INSERT INTO watchlist (tmdb_id, title, recommended_by) VALUES ($1, $2, $3)
           ON CONFLICT (tmdb_id) DO UPDATE SET recommended_by = EXCLUDED.recommended_by`,
          [tmdb_id, d.title || title, from_name]
        );
      } catch (e) {
        logger.error({ err: e }, 'recommendation add: watchlist insert');
      }
    }
    await pool.query(`UPDATE recommendations SET status = 'added' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'add recommendation');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/recommendations/:id/dismiss
router.post('/:id/dismiss', async (req, res) => {
  try {
    await pool.query(`UPDATE recommendations SET status = 'dismissed' WHERE id = $1`, [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'dismiss recommendation');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
