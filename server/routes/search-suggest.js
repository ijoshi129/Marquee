const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');

const router = express.Router();

// GET /api/search-suggest?q=<term>
// Returns grouped autocomplete suggestions: movies, directors, theaters.
router.get('/', async (req, res) => {
  try {
    const q = (req.query.q || '').trim().toLowerCase();
    if (q.length < 2) {
      return res.json({ movies: [], directors: [], theaters: [] });
    }
    const like = `%${q}%`;

    const [moviesQ, directorsQ, theatersQ, genresQ] = await Promise.all([
      pool.query(
        `SELECT w.id, COALESCE(tc.payload->>'title', w.title) AS title,
                tc.payload->>'poster_url' AS poster_url, w.watched_at
         FROM watches w
         LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
         WHERE LOWER(w.title) LIKE $1
            OR LOWER(COALESCE(tc.payload->>'title', '')) LIKE $1
         ORDER BY COALESCE(w.watched_at, w.showtime, w.created_at) DESC
         LIMIT 5`,
        [like]
      ),
      pool.query(
        `SELECT DISTINCT tc.payload->>'director' AS name
         FROM watches w
         JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
         WHERE tc.payload->>'director' IS NOT NULL
           AND LOWER(tc.payload->>'director') LIKE $1
         LIMIT 5`,
        [like]
      ),
      pool.query(
        `SELECT DISTINCT t.name
         FROM theaters t
         WHERE LOWER(t.name) LIKE $1
         LIMIT 5`,
        [like]
      ),
      // Genres are an array inside each TMDB payload; explode and filter.
      pool.query(
        `SELECT DISTINCT genre
         FROM tmdb_cache,
              jsonb_array_elements_text(payload->'genres') AS genre
         WHERE LOWER(genre) LIKE $1
         ORDER BY genre
         LIMIT 5`,
        [like]
      ),
    ]);

    res.json({
      movies: moviesQ.rows,
      directors: directorsQ.rows.map((r) => r.name).filter(Boolean),
      theaters: theatersQ.rows.map((r) => r.name).filter(Boolean),
      genres: genresQ.rows.map((r) => r.genre).filter(Boolean),
    });
  } catch (err) {
    logger.error({ err: err }, 'search-suggest');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
