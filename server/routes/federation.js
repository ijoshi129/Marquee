// Friend-facing federation API — the only externally-reachable surface other
// instances call. Access is a capability URL: the secret token in the path is
// the entire credential, matched (hashed, constant-time) against a friends row,
// which also identifies the caller. A wrong or rotated token gets a 404, same
// as a path that never existed. Responses are deliberately a small, explicit
// allowlist of fields — never the raw watch row — and every query hard-excludes
// private films regardless of the owner's sharing settings.

const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');
const fed = require('../services/federation');
const tmdb = require('../services/tmdb');
const { notify } = require('../services/notifications');
const federationSync = require('../workers/federation-sync');

const router = express.Router();

// Projection shaped exactly for the client's WatchCard, so a friend's cached
// watches render with no translation. `id` is renamed remote_id to make clear
// it's not a local row.
const SELECT_SHARED = `
  SELECT
    w.id AS remote_id, w.tmdb_id, w.title, w.showtime, w.status,
    w.rating, w.tags, w.watched_at,
    t.name AS theater_name,
    tc.payload AS tmdb,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('name', se.author_name, 'body', se.body, 'at', se.created_at) ORDER BY se.created_at)
                FROM social_events se WHERE se.watch_id = w.id AND se.kind = 'comment'), '[]'::jsonb) AS comments
  FROM watches w
  LEFT JOIN theaters t ON t.id = w.theater_id
  LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
`;

// Resolve the path token to a friends row. Fail-closed when federation is
// disabled; 404 (not 401) on no match so a rotated or removed URL is
// indistinguishable from nothing being there.
router.param('token', async (req, res, next, token) => {
  try {
    if (!fed.isEnabled()) {
      return res.status(503).json({ error: 'Federation is not enabled on this instance' });
    }
    if (!fed.TOKEN_RX.test(token)) return res.status(404).json({ error: 'Not found' });

    const hash = fed.sha256(token);
    const { rows } = await pool.query(
      `SELECT * FROM friends WHERE inbound_token_hash IS NOT NULL`
    );
    const friend = rows.find((f) => fed.safeEqualHex(f.inbound_token_hash, hash));
    if (!friend) return res.status(404).json({ error: 'Not found' });

    req.friend = friend;
    next();
  } catch (err) {
    logger.error({ err }, 'federation auth');
    res.status(500).json({ error: 'Server error' });
  }
});

function nullRatings(rows, settings) {
  if (settings.share_ratings) return rows;
  return rows.map((r) => ({ ...r, rating: null }));
}

// GET /api/federation/:token/feed — everything a friend syncs, in one payload:
// identity, a stats subset, upcoming reservations, and recent watched films
// (with their comment threads). A-List savings are never shared.
router.get('/:token/feed', async (req, res) => {
  try {
    const [identity, settings] = await Promise.all([fed.getIdentity(), fed.getSettings()]);
    const shared = `status = 'watched' AND is_private = FALSE`;

    let stats = null;
    if (settings.share_stats) {
      const [totals, genres, directors, topRated] = await Promise.all([
        pool.query(
          `SELECT COUNT(*)::int AS films,
                  COALESCE(SUM((tc.payload->>'runtime_minutes')::int), 0)::int AS runtime_minutes,
                  ROUND(AVG(w.rating)::numeric, 1) AS average_rating
             FROM watches w LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
            WHERE w.${shared}`
        ),
        pool.query(
          `SELECT g AS name, COUNT(*)::int AS count
             FROM watches w JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id,
                  jsonb_array_elements_text(tc.payload->'genres') g
            WHERE w.${shared}
            GROUP BY g ORDER BY count DESC, name LIMIT 10`
        ),
        pool.query(
          `SELECT tc.payload->>'director' AS name, COUNT(*)::int AS count
             FROM watches w JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
            WHERE w.${shared} AND tc.payload->>'director' IS NOT NULL
            GROUP BY name ORDER BY count DESC, name LIMIT 10`
        ),
        pool.query(
          `SELECT DISTINCT ON (w.tmdb_id) w.id, w.title,
                  tc.payload->>'poster_url' AS poster_url
             FROM watches w JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
            WHERE w.${shared} AND w.rating = 5
            ORDER BY w.tmdb_id, w.watched_at DESC NULLS LAST LIMIT 12`
        ),
      ]);
      stats = {
        films: totals.rows[0].films,
        runtime_minutes: totals.rows[0].runtime_minutes,
        average_rating: settings.share_ratings ? totals.rows[0].average_rating : null,
        genres: genres.rows,
        top_directors: directors.rows,
        top_rated: settings.share_ratings ? topRated.rows : [],
      };
    }

    let upcoming = [];
    if (settings.share_now_playing) {
      const up = await pool.query(
        `${SELECT_SHARED} WHERE w.status = 'pending' AND w.is_private = FALSE
           ORDER BY w.showtime ASC NULLS LAST LIMIT 20`
      );
      upcoming = up.rows;
    }

    let watches = [];
    if (settings.share_activity) {
      const limit = Math.min(settings.activity_limit || 50, 200);
      const act = await pool.query(
        `${SELECT_SHARED} WHERE w.status = 'watched' AND w.is_private = FALSE
           ORDER BY w.watched_at DESC NULLS LAST LIMIT $1`,
        [limit]
      );
      watches = nullRatings(act.rows, settings);
    }

    res.json({
      instance_id: identity.instance_id,
      display_name: identity.display_name,
      avatar_url: identity.avatar_url,
      stats,
      upcoming,
      shared: settings.share_activity,
      watches,
    });
  } catch (err) {
    logger.error({ err }, 'federation feed');
    res.status(500).json({ error: 'Server error' });
  }
});

// The friends row matched by the token IS the authenticated author — no claimed
// identity in the body is ever trusted. remote_instance_id may still be null if
// we've never pulled this friend's feed; fall back to the row id (also a UUID)
// so social_events' NOT NULL holds.
function authorOf(friend) {
  return {
    instance_id: friend.remote_instance_id || friend.id,
    name: (friend.display_name || 'A friend').slice(0, 120),
  };
}

const COMMENT_MAX = 1000;

async function handleComment(req, res) {
  const { target_watch_id, body } = req.body || {};
  if (!target_watch_id) {
    return res.status(400).json({ error: 'target_watch_id is required' });
  }
  const text = (body || '').trim().slice(0, COMMENT_MAX);
  if (!text) return res.status(400).json({ error: 'Empty comment' });

  const w = await pool.query(
    `SELECT w.title, tc.payload->>'title' AS tmdb_title
       FROM watches w LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
      WHERE w.id = $1 AND w.is_private = FALSE`,
    [target_watch_id]
  );
  if (!w.rows.length) return res.status(404).json({ error: 'Unknown film' });
  const filmTitle = w.rows[0].tmdb_title || w.rows[0].title;
  const author = authorOf(req.friend);

  await pool.query(
    `INSERT INTO social_events (watch_id, author_instance_id, author_name, kind, body)
     VALUES ($1, $2, $3, 'comment', $4)`,
    [target_watch_id, author.instance_id, author.name, text]
  );
  notify({
    kind: 'comment',
    title: `${author.name} commented on your ${filmTitle}`,
    body: text.length > 80 ? text.slice(0, 80) + '…' : text,
    payload: { watch_id: target_watch_id },
  }).catch(() => {});

  res.json({ ok: true });
}

async function handleRecommend(req, res) {
  const { tmdb_id, title } = req.body || {};
  if (!tmdb_id && !title) return res.status(400).json({ error: 'tmdb_id or title required' });
  // Cap peer-supplied strings so a friend can't store an unbounded blob.
  const clamp = (s, n) => (typeof s === 'string' ? s.slice(0, n) : s);
  const author = authorOf(req.friend);
  let filmTitle = clamp(title, 300);
  if (tmdb_id) {
    try {
      const d = await tmdb.getOrFetchDetails(tmdb_id);
      filmTitle = d.title || title;
    } catch {}
  }
  await pool.query(
    `INSERT INTO recommendations (from_instance_id, from_name, tmdb_id, title)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_instance_id, tmdb_id) WHERE tmdb_id IS NOT NULL
     DO UPDATE SET from_name = EXCLUDED.from_name, title = EXCLUDED.title,
                   status = 'pending', created_at = NOW()`,
    [author.instance_id, author.name, tmdb_id || null, filmTitle || `TMDB ${tmdb_id}`]
  );
  notify({
    kind: 'recommend',
    title: `${author.name} recommends ${filmTitle}`,
    body: 'Add it to your watchlist?',
    payload: { tmdb_id: tmdb_id || null },
  }).catch(() => {});
  res.json({ ok: true });
}

// A friend we've already handed a URL to sends theirs back here, so the owner
// never has to paste it. Fill only when our slot is empty: an already-linked row
// is left alone, so a captured token can't silently redirect our pulls (re-linking
// stays an owner action via PATCH/rotate).
async function handleConnect(req, res) {
  if (req.friend.friend_url) return res.json({ ok: true, linked: false });
  const friendUrl = fed.parseFriendUrl((req.body || {}).friend_url);
  if (!friendUrl) return res.status(400).json({ error: 'That URL doesn’t look like a Marquee friend URL' });

  const { rows } = await pool.query(
    `UPDATE friends SET friend_url = $1, last_error = NULL, updated_at = NOW()
      WHERE id = $2 AND friend_url IS NULL RETURNING id`,
    [friendUrl, req.friend.id]
  );
  res.json({ ok: true, linked: rows.length > 0 });
  if (rows.length) federationSync.syncFriendById(req.friend.id).catch(() => {});
}

// POST /api/federation/:token/inbox — everything a friend pushes to us:
//   { kind: 'ping' }                                — "I changed, pull me now"
//   { kind: 'connect', friend_url }                 — their URL back, for two-way
//   { kind: 'comment', target_watch_id, body }      — comment on one of our films
//   { kind: 'recommend', tmdb_id, title }           — recommend us a film
// We're the hub for events on our watches: a stored comment is re-broadcast to
// all friends inside our feed's comment threads.
router.post('/:token/inbox', async (req, res) => {
  try {
    const kind = (req.body || {}).kind;
    if (kind === 'ping') {
      res.json({ ok: true });
      federationSync.syncFriendById(req.friend.id).catch(() => {});
      return;
    }
    if (kind === 'connect') return await handleConnect(req, res);
    if (kind === 'comment') return await handleComment(req, res);
    if (kind === 'recommend') return await handleRecommend(req, res);
    res.status(400).json({ error: 'Unknown kind' });
  } catch (err) {
    logger.error({ err }, 'federation inbox');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
