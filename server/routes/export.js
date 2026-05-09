// GET /api/export — full JSON dump of every watch + theatre + cached TMDB
// metadata. Designed as a defensive escape hatch: if you ever need to leave
// this app or have a fatal bug, you can still walk away with all your data.
//
// Browser-friendly: sets Content-Disposition so hitting the URL triggers a
// download named `marquee-export-YYYY-MM-DD.json`. Add `?download=0` to
// inline the JSON instead.

const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const [watchesQ, theatersQ, tmdbQ] = await Promise.all([
      pool.query(
        `SELECT id, tmdb_id, title, showtime, watched_at, theater_id,
                rating, notes, status, source, acknowledged, tmdb_needs_review,
                created_at, updated_at
         FROM watches
         ORDER BY COALESCE(watched_at, showtime, created_at) DESC`
      ),
      pool.query(`SELECT id, name, created_at FROM theaters ORDER BY name`),
      pool.query(
        `SELECT tmdb_id, payload, fetched_at
         FROM tmdb_cache
         ORDER BY fetched_at DESC`
      ),
    ]);

    const payload = {
      exported_at: new Date().toISOString(),
      schema_version: 1,
      counts: {
        watches: watchesQ.rowCount,
        theaters: theatersQ.rowCount,
        tmdb_cache: tmdbQ.rowCount,
      },
      watches: watchesQ.rows,
      theaters: theatersQ.rows,
      tmdb_cache: tmdbQ.rows,
    };

    if (req.query.download !== '0') {
      const today = new Date().toISOString().slice(0, 10);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="marquee-export-${today}.json"`
      );
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload, null, 2));
  } catch (err) {
    logger.error({ err: err }, 'export failed');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
