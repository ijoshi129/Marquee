// Owner-facing friends API: pairing, friend management, sharing settings, and
// reads from the local cache the sync worker populates. These routes are part
// of the owner's own surface (same posture as /api/watches) — the per-friend
// token boundary lives on /api/federation, not here.

const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');
const fed = require('../services/federation');
const { notify } = require('../services/notifications');
const federationSync = require('../workers/federation-sync');

const router = express.Router();

const INVITE_TTL_MS = 15 * 60 * 1000;
const PAIR_TIMEOUT_MS = 10_000;

function baseUrl() {
  return process.env.FEDERATION_BASE_URL || null;
}

function encodeInvite(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}
function decodeInvite(str) {
  return JSON.parse(Buffer.from(str, 'base64url').toString('utf8'));
}

// GET /api/friends — list paired/pending friends (never returns tokens).
router.get('/', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, remote_instance_id, display_name, avatar_url, base_url,
              status, direction, last_synced_at, last_error, created_at
         FROM friends ORDER BY created_at DESC`
    );
    res.json(rows);
  } catch (err) {
    logger.error({ err }, 'list friends');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/friends/settings — current sharing settings.
router.get('/settings', async (req, res) => {
  try {
    res.json(await fed.getSettings());
  } catch (err) {
    logger.error({ err }, 'get federation settings');
    res.status(500).json({ error: 'Server error' });
  }
});

// PUT /api/friends/settings — update sharing toggles.
const SETTING_FIELDS = ['share_ratings', 'share_activity', 'share_now_playing', 'share_stats', 'activity_limit'];
router.put('/settings', async (req, res) => {
  try {
    const updates = [];
    const params = [];
    for (const f of SETTING_FIELDS) {
      if (f in req.body) {
        params.push(req.body[f]);
        updates.push(`${f} = $${params.length}`);
      }
    }
    if (!updates.length) return res.status(400).json({ error: 'No fields to update' });
    await pool.query(
      `UPDATE federation_settings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = TRUE`,
      params
    );
    fed.notifyFriends();
    res.json(await fed.getSettings());
  } catch (err) {
    logger.error({ err }, 'update federation settings');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/friends/invite — mint a one-time invite string to hand a friend
// out-of-band. Stores only the hash of the code.
router.post('/invite', async (req, res) => {
  try {
    if (!baseUrl()) {
      return res.status(503).json({ error: 'FEDERATION_BASE_URL must be set to invite friends' });
    }
    const code = fed.generateSecret();
    await pool.query(
      `INSERT INTO federation_invites (code_hash, expires_at)
       VALUES ($1, NOW() + INTERVAL '${INVITE_TTL_MS} milliseconds')`,
      [fed.sha256(code)]
    );
    res.json({ invite: encodeInvite({ base_url: baseUrl(), code }) });
  } catch (err) {
    logger.error({ err }, 'create invite');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/friends/accept { invite } — redeem an invite string: call the
// inviter's /pair, exchange identities + per-direction tokens, store the friend.
router.post('/accept', async (req, res) => {
  try {
    if (!baseUrl()) {
      return res.status(503).json({ error: 'FEDERATION_BASE_URL must be set to accept invites' });
    }
    let decoded;
    try {
      decoded = decodeInvite((req.body || {}).invite || '');
    } catch {
      return res.status(400).json({ error: 'Invalid invite string' });
    }
    if (!decoded.base_url || !decoded.code) {
      return res.status(400).json({ error: 'Invalid invite string' });
    }

    const me = await fed.getIdentity();
    // The token the inviter will present to US on future calls.
    const ourInboundToken = fed.generateSecret();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
    let pairRes;
    try {
      const resp = await fetch(`${decoded.base_url.replace(/\/$/, '')}/api/federation/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: decoded.code,
          instance_id: me.instance_id,
          display_name: me.display_name,
          base_url: baseUrl(),
          token: ourInboundToken,
        }),
        signal: controller.signal,
      });
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({}));
        return res.status(resp.status === 401 ? 401 : 502).json({
          error: body.error || `Pairing failed (${resp.status})`,
        });
      }
      pairRes = await resp.json();
    } catch (err) {
      logger.error({ err }, 'pair request failed');
      return res.status(502).json({ error: 'Could not reach the inviting instance' });
    } finally {
      clearTimeout(timer);
    }

    const { rows } = await pool.query(
      `INSERT INTO friends
         (remote_instance_id, display_name, avatar_url, base_url, status,
          direction, inbound_token_hash, outbound_token)
       VALUES ($1, $2, $3, $4, 'active', 'accepted', $5, $6)
       ON CONFLICT (remote_instance_id) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         avatar_url = EXCLUDED.avatar_url,
         base_url = EXCLUDED.base_url,
         status = 'active',
         inbound_token_hash = EXCLUDED.inbound_token_hash,
         outbound_token = EXCLUDED.outbound_token,
         updated_at = NOW()
       RETURNING id, remote_instance_id, display_name, base_url, status`,
      [
        pairRes.instance_id,
        pairRes.display_name || null,
        pairRes.avatar_url || null,
        decoded.base_url,
        fed.sha256(ourInboundToken),
        pairRes.token,
      ]
    );

    notify({
      kind: 'friend_added',
      title: `You're now connected with ${pairRes.display_name || 'a friend'}`,
      payload: { friend_id: rows[0].id },
      dedupeKey: `friend:${pairRes.instance_id}`,
    }).catch(() => {});
    federationSync.syncOnce().catch(() => {});
    res.status(201).json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'accept invite');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/friends/sync-now — trigger an immediate sync of all friends.
router.post('/sync-now', async (req, res) => {
  try {
    await federationSync.syncOnce();
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'manual sync');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/friends/feed — merged, chronological activity across all friends.
// Watched films are listed per friend. Upcoming reservations that share the same
// film + theatre + showtime (across friends and you) are merged into a single
// "seeing together" card.
router.get('/feed', async (req, res) => {
  try {
    const [watched, profiles, mine] = await Promise.all([
      pool.query(
        `SELECT fw.friend_id, f.display_name AS friend_name, fw.payload, fw.watched_at
           FROM friend_watches fw JOIN friends f ON f.id = fw.friend_id
          WHERE f.status = 'active'
          ORDER BY fw.watched_at DESC NULLS LAST
          LIMIT 200`
      ),
      pool.query(
        `SELECT fp.friend_id, f.display_name AS friend_name, fp.now_playing
           FROM friend_profiles fp JOIN friends f ON f.id = fp.friend_id
          WHERE f.status = 'active'`
      ),
      pool.query(
        `SELECT w.tmdb_id, w.title, w.showtime, t.name AS theater_name, tc.payload AS tmdb
           FROM watches w
           LEFT JOIN theaters t ON t.id = w.theater_id
           LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
          WHERE w.status = 'pending' AND w.showtime IS NOT NULL`
      ),
    ]);

    const watchedItems = watched.rows.map((r) => {
      const p = r.payload || {};
      return {
        id: `${r.friend_id}:${p.remote_id}`,
        kind: 'watched',
        friend_id: r.friend_id,
        friend_name: r.friend_name,
        title: p.tmdb?.title || p.title,
        poster_url: p.tmdb?.poster_url || null,
        release_year: p.tmdb?.release_year || null,
        director: p.tmdb?.director || null,
        rating: p.rating ?? null,
        at: r.watched_at || null,
      };
    });

    // Strict match key: film (tmdb id, else normalized title) + theatre + minute.
    const norm = (s) => (s || '').trim().toLowerCase();
    const filmKey = (p) => (p.tmdb_id ? `t:${p.tmdb_id}` : `n:${norm(p.tmdb?.title || p.title)}`);
    const matchKey = (p) =>
      `${filmKey(p)}|${norm(p.theater_name)}|${new Date(p.showtime).toISOString().slice(0, 16)}`;

    // Gather every upcoming reservation (friends' shared + your own) that has a
    // showtime and theatre, so it can participate in a match.
    const groups = new Map();
    const add = (p, who) => {
      if (!p.showtime || !p.theater_name) return;
      const k = matchKey(p);
      if (!groups.has(k)) groups.set(k, { p, people: [] });
      groups.get(k).people.push(who);
    };
    for (const r of profiles.rows) {
      for (const p of Array.isArray(r.now_playing) ? r.now_playing : []) {
        add(p, { friend_id: r.friend_id, name: r.friend_name });
      }
    }
    for (const p of mine.rows) add(p, { you: true });

    const upcomingItems = [];
    for (const [k, g] of groups) {
      // Dedupe people (one entry per friend / you).
      const seen = new Set();
      const people = g.people.filter((w) => {
        const id = w.you ? 'you' : w.friend_id;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      const friends = people.filter((w) => !w.you);
      const youIn = people.some((w) => w.you);

      // A solo *your-only* reservation isn't friend activity — skip it.
      if (friends.length === 0) continue;

      const p = g.p;
      upcomingItems.push({
        id: `up:${k}`,
        kind: 'upcoming',
        together: people.length > 1,
        you: youIn,
        people: people.map((w) =>
          w.you ? { name: 'You', you: true } : { name: w.name, friend_id: w.friend_id }
        ),
        // Link to a profile only when exactly one friend is involved.
        friend_id: friends.length === 1 ? friends[0].friend_id : null,
        friend_name: friends.length === 1 ? friends[0].name : null,
        title: p.tmdb?.title || p.title,
        poster_url: p.tmdb?.poster_url || null,
        release_year: p.tmdb?.release_year || null,
        director: p.tmdb?.director || null,
        theater_name: p.theater_name || null,
        showtime: p.showtime || null,
        at: p.showtime || null,
      });
    }

    const items = [...watchedItems, ...upcomingItems].sort((a, b) => {
      if (!a.at && !b.at) return 0;
      if (!a.at) return 1;
      if (!b.at) return -1;
      return new Date(b.at) - new Date(a.at);
    });

    res.json(items.slice(0, 200));
  } catch (err) {
    logger.error({ err }, 'friends feed');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/friends/:id/watches — cached friend watches (WatchCard-shaped payloads).
router.get('/:id/watches', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT payload FROM friend_watches WHERE friend_id = $1
         ORDER BY watched_at DESC NULLS LAST`,
      [req.params.id]
    );
    res.json(rows.map((r) => r.payload));
  } catch (err) {
    logger.error({ err }, 'friend watches');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/friends/:id/profile — cached friend profile (stats + upcoming).
router.get('/:id/profile', async (req, res) => {
  try {
    const friendRes = await pool.query(
      `SELECT id, display_name, avatar_url, last_synced_at, last_error
         FROM friends WHERE id = $1`,
      [req.params.id]
    );
    if (!friendRes.rows.length) return res.status(404).json({ error: 'Not found' });
    const profRes = await pool.query(
      `SELECT stats, now_playing, fetched_at FROM friend_profiles WHERE friend_id = $1`,
      [req.params.id]
    );
    res.json({ ...friendRes.rows[0], ...(profRes.rows[0] || {}) });
  } catch (err) {
    logger.error({ err }, 'friend profile');
    res.status(500).json({ error: 'Server error' });
  }
});

// DELETE /api/friends/:id — remove a friend. Their inbound token stops matching
// (row gone), we stop polling them, and cached data cascades away.
router.delete('/:id', async (req, res) => {
  try {
    const result = await pool.query('DELETE FROM friends WHERE id = $1 RETURNING id', [req.params.id]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ deleted: req.params.id });
  } catch (err) {
    logger.error({ err }, 'delete friend');
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
