// Friend-facing federation API. This is the only externally-reachable surface
// other instances call. Every data route is gated by a per-friend bearer token;
// /pair is gated by a one-time invite code. Responses are deliberately a small,
// explicit allowlist of fields — never the raw watch row — and every query
// hard-excludes private films regardless of the owner's sharing settings.

const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');
const fed = require('../services/federation');
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

// Authenticate a calling friend by the token they present. Fail-closed when
// federation is disabled. Matches an *active* friend by sha256(token); a
// revoked friend stops matching immediately.
async function requireFriendToken(req, res, next) {
  try {
    if (!fed.isEnabled()) {
      return res.status(503).json({ error: 'Federation is not enabled on this instance' });
    }
    const auth = req.get('authorization') || '';
    const token = auth.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!token) return res.status(401).json({ error: 'Friend token required' });

    const hash = fed.sha256(token);
    const { rows } = await pool.query(
      `SELECT * FROM friends WHERE status = 'active' AND inbound_token_hash IS NOT NULL`
    );
    const friend = rows.find((f) => fed.safeEqualHex(f.inbound_token_hash, hash));
    if (!friend) return res.status(401).json({ error: 'Unknown or revoked friend' });

    req.friend = friend;
    next();
  } catch (err) {
    logger.error({ err }, 'federation auth');
    res.status(500).json({ error: 'Server error' });
  }
}

function nullRatings(rows, settings) {
  if (settings.share_ratings) return rows;
  return rows.map((r) => ({ ...r, rating: null }));
}

// POST /api/federation/pair — the invitee calls this on the inviter to complete
// pairing. Gated entirely by knowledge of the one-time invite code. Idempotent
// on remote_instance_id so a replayed call can't fork state.
router.post('/pair', async (req, res) => {
  const client = await pool.connect();
  try {
    if (!fed.isEnabled()) {
      return res.status(503).json({ error: 'Federation is not enabled on this instance' });
    }
    const { code, instance_id, display_name, base_url, token } = req.body || {};
    if (!code || !instance_id || !base_url || !token) {
      return res.status(400).json({ error: 'code, instance_id, base_url and token are required' });
    }

    const codeHash = fed.sha256(code);
    await client.query('BEGIN');

    const inviteRes = await client.query(
      `SELECT * FROM federation_invites
         WHERE redeemed_at IS NULL AND expires_at > NOW()`
    );
    const invite = inviteRes.rows.find((i) => fed.safeEqualHex(i.code_hash, codeHash));
    if (!invite) {
      await client.query('ROLLBACK');
      return res.status(401).json({ error: 'Invalid or expired invite code' });
    }

    // The token WE will accept from this friend on future calls (store its hash).
    const ourInboundToken = fed.generateSecret();

    const friendRes = await client.query(
      `INSERT INTO friends
         (remote_instance_id, display_name, base_url, status, direction,
          inbound_token_hash, outbound_token)
       VALUES ($1, $2, $3, 'active', 'invited', $4, $5)
       ON CONFLICT (remote_instance_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         base_url = EXCLUDED.base_url,
         status = 'active',
         inbound_token_hash = EXCLUDED.inbound_token_hash,
         outbound_token = EXCLUDED.outbound_token,
         updated_at = NOW()
       RETURNING id`,
      [instance_id, display_name || null, base_url, fed.sha256(ourInboundToken), token]
    );

    await client.query(
      `UPDATE federation_invites SET redeemed_at = NOW(), friend_id = $1 WHERE id = $2`,
      [friendRes.rows[0].id, invite.id]
    );
    await client.query('COMMIT');

    notify({
      kind: 'friend_added',
      title: `You're now connected with ${display_name || 'a friend'}`,
      payload: { friend_id: friendRes.rows[0].id },
      dedupeKey: `friend:${instance_id}`,
    }).catch(() => {});

    const me = await fed.getIdentity();
    res.json({
      instance_id: me.instance_id,
      display_name: me.display_name,
      avatar_url: me.avatar_url,
      token: ourInboundToken,
    });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'federation pair');
    res.status(500).json({ error: 'Server error' });
  } finally {
    client.release();
  }
});

// GET /api/federation/profile — identity + a stats subset + (optionally) the
// owner's upcoming reservations. A-List savings are never shared.
router.get('/profile', requireFriendToken, async (req, res) => {
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

    res.json({
      instance_id: identity.instance_id,
      display_name: identity.display_name,
      avatar_url: identity.avatar_url,
      stats,
      upcoming,
    });
  } catch (err) {
    logger.error({ err }, 'federation profile');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/federation/activity?since=&limit= — recent watched, non-private films.
router.get('/activity', requireFriendToken, async (req, res) => {
  try {
    const settings = await fed.getSettings();
    if (!settings.share_activity) return res.json({ shared: false, watches: [] });

    const params = [];
    const where = [`w.status = 'watched'`, `w.is_private = FALSE`];
    if (req.query.since) {
      params.push(req.query.since);
      where.push(`w.watched_at > $${params.length}`);
    }
    const limit = Math.min(parseInt(req.query.limit, 10) || settings.activity_limit, 200);
    params.push(limit);

    const sql = `${SELECT_SHARED} WHERE ${where.join(' AND ')}
      ORDER BY w.watched_at DESC NULLS LAST LIMIT $${params.length}`;
    const { rows } = await pool.query(sql, params);
    res.json({ shared: true, watches: nullRatings(rows, settings) });
  } catch (err) {
    logger.error({ err }, 'federation activity');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/federation/ping — a friend telling us they just changed something.
// Respond immediately and pull just them, so updates land within seconds instead
// of waiting for the next poll.
router.post('/ping', requireFriendToken, async (req, res) => {
  res.json({ ok: true });
  federationSync.syncFriendById(req.friend.id).catch(() => {});
});

// POST /api/federation/inbox — a friend commenting on one of our films. We're
// the hub for events on our watches: store it, notify the owner, and it gets
// re-broadcast to our friends via /activity. Gated by friend token.
const COMMENT_MAX = 1000;
router.post('/inbox', requireFriendToken, async (req, res) => {
  try {
    const { kind, target_watch_id, body } = req.body || {};
    if (kind !== 'comment' || !target_watch_id) {
      return res.status(400).json({ error: 'comment kind and target_watch_id are required' });
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
    const name = req.friend.display_name || 'A friend';

    await pool.query(
      `INSERT INTO social_events (watch_id, author_instance_id, author_name, kind, body)
       VALUES ($1, $2, $3, 'comment', $4)`,
      [target_watch_id, req.friend.remote_instance_id, name, text]
    );
    notify({
      kind: 'comment',
      title: `${name} commented on your ${filmTitle}`,
      body: text.length > 80 ? text.slice(0, 80) + '…' : text,
      payload: { watch_id: target_watch_id },
    }).catch(() => {});

    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'federation inbox');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
