const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');
const tmdb = require('../services/tmdb');
const { upsertTheater } = require('../services/theaters');
const unseenLookup = require('../services/unseen-lookup');

const router = express.Router();

const SELECT_WATCH = `
  SELECT
    w.id, w.tmdb_id, w.title, w.showtime,
    w.status, w.source, w.rating, w.notes, w.tmdb_needs_review,
    w.reservation_email_id, w.thankyou_email_id,
    w.tags,
    w.watched_at, w.created_at, w.updated_at,
    t.id  AS theater_id,
    t.name AS theater_name,
    tc.payload AS tmdb
  FROM watches w
  LEFT JOIN theaters t  ON t.id = w.theater_id
  LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
`;

const SORT_COLS = {
  date: `COALESCE(w.watched_at, w.showtime, w.created_at)`,
  rating: `w.rating`,
  runtime: `(tc.payload->>'runtime_minutes')::int`,
  title: `LOWER(COALESCE(tc.payload->>'title', w.title))`,
};

router.get('/', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const offset = parseInt(req.query.offset, 10) || 0;

    const where = [];
    const params = [];

    // status: comma-separated list, or 'all' to skip filtering. Default hides
    // cancelled and no_show.
    const statusParam = req.query.status;
    if (statusParam && statusParam !== 'all') {
      const list = statusParam.split(',').map((s) => s.trim()).filter(Boolean);
      if (list.length) {
        params.push(list);
        where.push(`w.status = ANY($${params.length}::text[])`);
      }
    } else if (!statusParam) {
      params.push(['watched', 'pending']);
      where.push(`w.status = ANY($${params.length}::text[])`);
    }

    // Date range (period filter). ISO date strings; half-open [from, to).
    // When include_pending=1 is passed alongside a date range, pending rows
    // escape the year scope — used by the main grid so upcoming reservations
    // dated for a different year still surface on the active view.
    const dateClauses = [];
    if (req.query.from) {
      params.push(req.query.from);
      dateClauses.push(
        `COALESCE(w.watched_at, w.showtime, w.created_at) >= $${params.length}`
      );
    }
    if (req.query.to) {
      params.push(req.query.to);
      dateClauses.push(
        `COALESCE(w.watched_at, w.showtime, w.created_at) < $${params.length}`
      );
    }
    if (dateClauses.length) {
      const dateExpr = dateClauses.join(' AND ');
      if (req.query.include_pending === '1') {
        where.push(`(${dateExpr} OR w.status = 'pending')`);
      } else {
        where.push(dateExpr);
      }
    }

    // Broad search: own title + notes + theater + entire TMDB payload (title,
    // original_title, director, genres array, overview).
    if (req.query.q && req.query.q.trim()) {
      params.push(`%${req.query.q.trim().toLowerCase()}%`);
      const i = params.length;
      where.push(
        `(LOWER(w.title) LIKE $${i}
           OR LOWER(COALESCE(w.notes, '')) LIKE $${i}
           OR LOWER(COALESCE(t.name, '')) LIKE $${i}
           OR LOWER(COALESCE(tc.payload::text, '')) LIKE $${i})`
      );
    }

    // Genre: jsonb element-exists check on the TMDB genres array.
    if (req.query.genre) {
      params.push(req.query.genre);
      where.push(`tc.payload->'genres' ? $${params.length}`);
    }

    // Director: exact match against TMDB-cached director name.
    if (req.query.director) {
      params.push(req.query.director);
      where.push(`tc.payload->>'director' = $${params.length}`);
    }

    // Minimum rating.
    if (req.query.min_rating) {
      const n = parseInt(req.query.min_rating, 10);
      if (!Number.isNaN(n)) {
        params.push(n);
        where.push(`w.rating >= $${params.length}`);
      }
    }

    // Tag filter — exact match in the tags array. Replaces the older
    // `format` param that ILIKE-matched the title for Screen/Scream Unseen.
    if (req.query.tag) {
      params.push(req.query.tag);
      where.push(`$${params.length} = ANY(w.tags)`);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const sortCol = SORT_COLS[req.query.sort] || SORT_COLS.date;
    const dir = req.query.dir === 'asc' ? 'ASC' : 'DESC';
    const nulls = dir === 'DESC' ? 'NULLS LAST' : 'NULLS FIRST';

    params.push(limit, offset);
    const sql = `${SELECT_WATCH} ${whereSql}
      ORDER BY ${sortCol} ${dir} ${nulls}
      LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const result = await pool.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logger.error({ err: err }, 'list watches');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/watches/notifications — rows the user hasn't acknowledged yet
// (auto-flipped to no_show or cancelled). Sorted newest first.
// Declared before /:id so Express doesn't route "notifications" as an id.
router.get('/notifications', async (req, res) => {
  try {
    const result = await pool.query(
      `${SELECT_WATCH} WHERE w.acknowledged = FALSE ORDER BY w.updated_at DESC LIMIT 50`
    );
    res.json(result.rows);
  } catch (err) {
    logger.error({ err: err }, 'notifications');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/:id', async (req, res) => {
  try {
    const result = await pool.query(`${SELECT_WATCH} WHERE w.id = $1`, [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error({ err: err }, 'get watch');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/watches — create a manual watch
// body: { title, theater_name, showtime?, rating?, notes?, watched_at?, status? }
router.post('/', async (req, res) => {
  try {
    const {
      title,
      theater_name,
      showtime,
      rating,
      notes,
      watched_at,
      status,
      tags,
      tmdb_id: explicitTmdbId,
    } = req.body || {};

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'title is required' });
    }

    const theater = theater_name ? await upsertTheater(theater_name) : null;

    let tmdbId = null;
    let needsReview = false;
    if (explicitTmdbId) {
      // Caller picked an exact TMDB result (e.g. via add-watch autocomplete).
      // Skip autoMatch; just make sure we have the details cached.
      try {
        await tmdb.getOrFetchDetails(explicitTmdbId);
        tmdbId = explicitTmdbId;
      } catch (err) {
        logger.error({ err: err }, 'TMDB explicit fetch failed (non-fatal)');
        needsReview = true;
      }
    } else {
      try {
        const match = await tmdb.autoMatch(title);
        if (match) {
          tmdbId = match.tmdb_id;
          needsReview = match.needs_review;
        } else {
          needsReview = true;
        }
      } catch (err) {
        logger.error({ err: err }, 'TMDB enrichment failed (non-fatal)');
        needsReview = true;
      }
    }

    const finalStatus = status || 'watched';
    const finalWatchedAt = watched_at || (finalStatus === 'watched' ? new Date().toISOString() : null);

    const insert = await pool.query(
      `INSERT INTO watches
        (tmdb_id, title, showtime, theater_id, status, source,
         rating, notes, tmdb_needs_review, watched_at, tags)
       VALUES ($1, $2, $3, $4, $5, 'manual', $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        tmdbId,
        title.trim(),
        showtime || null,
        theater ? theater.id : null,
        finalStatus,
        rating || null,
        notes || null,
        needsReview,
        finalWatchedAt,
        Array.isArray(tags) ? tags : [],
      ]
    );

    const created = await pool.query(`${SELECT_WATCH} WHERE w.id = $1`, [insert.rows[0].id]);
    res.status(201).json(created.rows[0]);
  } catch (err) {
    logger.error({ err: err }, 'create watch');
    res.status(500).json({ error: 'Server error' });
  }
});

// PATCH /api/watches/:id — update mutable fields
const PATCH_FIELDS = [
  'title', 'rating', 'notes', 'status', 'watched_at',
  'showtime', 'acknowledged', 'tags',
];

router.patch('/:id', async (req, res) => {
  try {
    const updates = [];
    const params = [];

    for (const field of PATCH_FIELDS) {
      if (field in req.body) {
        params.push(req.body[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }

    // When promoting to 'watched', fill in watched_at if the caller didn't set
    // it explicitly (so a row marked-as-watched-from-no_show keeps a sensible date).
    if (req.body.status === 'watched' && !('watched_at' in req.body)) {
      updates.push(`watched_at = COALESCE(watched_at, showtime, NOW())`);
    }

    // Auto-acknowledge on user-initiated status change OR when assigning a
    // TMDB id (e.g. resolving a Screen Unseen by hand). Skipped if the caller
    // is being explicit about acknowledged.
    if (
      ('status' in req.body || 'tmdb_id' in req.body) &&
      !('acknowledged' in req.body)
    ) {
      updates.push(`acknowledged = TRUE`);
    }

    // Theater rename: accept theater_name string
    if ('theater_name' in req.body) {
      const t = req.body.theater_name ? await upsertTheater(req.body.theater_name) : null;
      params.push(t ? t.id : null);
      updates.push(`theater_id = $${params.length}`);
    }

    // Manual TMDB override
    if ('tmdb_id' in req.body) {
      const id = req.body.tmdb_id;
      if (id) {
        try {
          await tmdb.getOrFetchDetails(id);
        } catch (err) {
          return res.status(400).json({ error: `TMDB id ${id} could not be fetched` });
        }
      }
      params.push(id || null);
      updates.push(`tmdb_id = $${params.length}`);
      params.push(false);
      updates.push(`tmdb_needs_review = $${params.length}`);
    }

    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });

    params.push(req.params.id);
    const sql = `UPDATE watches SET ${updates.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING id`;
    const result = await pool.query(sql, params);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });

    const refreshed = await pool.query(`${SELECT_WATCH} WHERE w.id = $1`, [req.params.id]);
    res.json(refreshed.rows[0]);
  } catch (err) {
    logger.error({ err: err }, 'update watch');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/watches/:id/recheck-unseen — manual Reddit lookup for AMC Screen/Scream
// Unseens. Clears the in-memory megathread cache first so a fresh fetch happens.
router.post('/:id/recheck-unseen', async (req, res) => {
  try {
    unseenLookup.clearCaches();
    const result = await unseenLookup.resolveAndAssign(req.params.id, { force: true });
    const refreshed = await pool.query(`${SELECT_WATCH} WHERE w.id = $1`, [req.params.id]);
    if (!refreshed.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({
      resolved: result.resolved,
      reason: result.reason || null,
      title: result.title || null,
      watch: refreshed.rows[0],
    });
  } catch (err) {
    logger.error({ err: err }, 'recheck-unseen');
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM watches WHERE id = $1 RETURNING id', [
      req.params.id,
    ]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: req.params.id });
  } catch (err) {
    logger.error({ err: err }, 'delete watch');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
