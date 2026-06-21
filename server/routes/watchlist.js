const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');
const tmdb = require('../services/tmdb');
const trakt = require('../services/trakt');

const router = express.Router();

const LIST_SELECT = `
  SELECT wl.id, wl.tmdb_id, wl.title, wl.added_at, tc.payload AS tmdb
  FROM watchlist wl
  LEFT JOIN tmdb_cache tc ON tc.tmdb_id = wl.tmdb_id
`;

// GET /api/watchlist — the list, newest first.
router.get('/', async (req, res) => {
  try {
    const r = await pool.query(`${LIST_SELECT} ORDER BY wl.added_at DESC`);
    res.json(r.rows);
  } catch (err) {
    logger.error({ err }, 'watchlist list');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/watchlist/now-playing — TMDB discovery feed, flagged with whether
// each film is already on the watchlist or already in the diary.
router.get('/now-playing', async (req, res) => {
  try {
    const results = await tmdb.nowPlaying();
    const ids = results.map((r) => r.tmdb_id);
    const [onList, watched] = await Promise.all([
      pool.query('SELECT tmdb_id FROM watchlist WHERE tmdb_id = ANY($1)', [ids]),
      pool.query("SELECT DISTINCT tmdb_id FROM watches WHERE status = 'watched' AND tmdb_id = ANY($1)", [ids]),
    ]);
    const onSet = new Set(onList.rows.map((r) => r.tmdb_id));
    const seenSet = new Set(watched.rows.map((r) => r.tmdb_id));
    res.json(
      results.map((r) => ({
        ...r,
        on_watchlist: onSet.has(r.tmdb_id),
        seen: seenSet.has(r.tmdb_id),
      }))
    );
  } catch (err) {
    logger.error({ err }, 'watchlist now-playing');
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

// POST /api/watchlist — add a film by TMDB id. Idempotent on tmdb_id.
router.post('/', async (req, res) => {
  const tmdbId = Number(req.body?.tmdb_id);
  if (!tmdbId) return res.status(400).json({ error: 'tmdb_id required' });
  try {
    const details = await tmdb.getOrFetchDetails(tmdbId);
    await pool.query(
      `INSERT INTO watchlist (tmdb_id, title) VALUES ($1, $2)
       ON CONFLICT (tmdb_id) DO NOTHING`,
      [tmdbId, details.title || `TMDB ${tmdbId}`]
    );
    const row = await pool.query(`${LIST_SELECT} WHERE wl.tmdb_id = $1`, [tmdbId]);
    res.status(201).json(row.rows[0]);
  } catch (err) {
    logger.error({ err }, 'watchlist add');
    res.status(500).json({ error: `Could not add TMDB ${tmdbId}` });
  }
});

// DELETE /api/watchlist/:id — drop a film from the list.
router.delete('/:id', async (req, res) => {
  try {
    const r = await pool.query('DELETE FROM watchlist WHERE id = $1 RETURNING id', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'watchlist delete');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/watchlist/:id/watched — log it as watched and remove it from the
// list. Optional rating / watched_at; defaults watched_at to now.
router.post('/:id/watched', async (req, res) => {
  try {
    const wl = await pool.query('SELECT tmdb_id, title FROM watchlist WHERE id = $1', [
      req.params.id,
    ]);
    if (!wl.rows.length) return res.status(404).json({ error: 'Not found' });
    const item = wl.rows[0];
    const { rating, watched_at } = req.body || {};

    const insert = await pool.query(
      `INSERT INTO watches (tmdb_id, title, status, source, rating, watched_at, tmdb_needs_review)
       VALUES ($1, $2, 'watched', 'manual', $3, $4, FALSE)
       RETURNING id`,
      [item.tmdb_id, item.title, rating || null, watched_at || new Date().toISOString()]
    );
    await pool.query('DELETE FROM watchlist WHERE id = $1', [req.params.id]);

    trakt.queueWatch(insert.rows[0].id).catch((err) => {
      logger.error({ err, watch_id: insert.rows[0].id }, 'trakt queue failed (non-fatal)');
    });
    res.status(201).json({ watch_id: insert.rows[0].id });
  } catch (err) {
    logger.error({ err }, 'watchlist mark-watched');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
