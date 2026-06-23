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

// Friend ids are UUIDs — reject a malformed :id with 404 before it reaches
// Postgres as an invalid-uuid cast (which would surface as an opaque 500).
const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('id', (req, res, next, id) => {
  if (!UUID_RX.test(id)) return res.status(404).json({ error: 'Not found' });
  next();
});

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
    // The invite's base_url is fetched server-side with our token — vet it before
    // we ever call it, and store the normalized form.
    const inviterUrl = fed.safeBaseUrl(decoded.base_url);
    if (!inviterUrl) {
      return res.status(400).json({ error: 'Invite points at an unacceptable address' });
    }

    const me = await fed.getIdentity();
    // The token the inviter will present to US on future calls.
    const ourInboundToken = fed.generateSecret();

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PAIR_TIMEOUT_MS);
    let pairRes;
    try {
      const resp = await fetch(`${inviterUrl}/api/federation/pair`, {
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
        inviterUrl,
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
    // Our token pair is now stored on both sides, so it's safe to tell the inviter
    // to pull us — this is what populates the inviter's feed on pairing, without
    // the race that an immediate pull from /pair would hit.
    fed.notifyFriends();
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

// POST /api/friends/:id/sync — sync just this friend now, returning its fresh state.
router.post('/:id/sync', async (req, res) => {
  try {
    await federationSync.syncFriendById(req.params.id);
    const { rows } = await pool.query(
      `SELECT id, display_name, status, last_synced_at, last_error FROM friends WHERE id = $1`,
      [req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Friend not found' });
    res.json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'manual friend sync');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/friends/:id/test-connection — actively probe whether we can reach this
// friend's instance and whether our token is still accepted. Diagnostic only; it
// doesn't change any stored state.
const TEST_TIMEOUT_MS = 8000;
router.post('/:id/test-connection', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT base_url, outbound_token FROM friends WHERE id = $1`,
      [req.params.id]
    );
    const f = rows[0];
    if (!f) return res.status(404).json({ error: 'Friend not found' });

    const url = `${f.base_url.replace(/\/$/, '')}/api/federation/profile`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEST_TIMEOUT_MS);
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        headers: { authorization: `Bearer ${f.outbound_token}` },
        signal: controller.signal,
      });
      const ms = Date.now() - t0;
      if (resp.ok) {
        return res.json({ ok: true, reachable: true, authorized: true, ms });
      }
      if (resp.status === 401) {
        return res.json({
          ok: false, reachable: true, authorized: false, ms,
          message: 'Reached them, but our access was rejected — they may have removed you. Re-pair to fix.',
        });
      }
      return res.json({
        ok: false, reachable: true, authorized: false, ms,
        message: `Reached them but got HTTP ${resp.status}.`,
      });
    } catch (err) {
      const ms = Date.now() - t0;
      const message =
        err.name === 'AbortError'
          ? "Timed out — their instance isn't reachable from here. Check their FEDERATION_BASE_URL and the network between you."
          : `Couldn't connect: ${err.message}`;
      return res.json({ ok: false, reachable: false, authorized: false, ms, message });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    logger.error({ err }, 'test connection');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/friends/feed — merged, chronological activity across all friends.
// Watched films are listed per friend. Upcoming reservations that share the same
// film + theatre + showtime (across friends and you) are merged into a single
// "seeing together" card.
router.get('/feed', async (req, res) => {
  try {
    const [watched, profiles, mine, identity] = await Promise.all([
      pool.query(
        `SELECT fw.friend_id, f.display_name AS friend_name, fw.payload, fw.watched_at
           FROM friend_watches fw JOIN friends f ON f.id = fw.friend_id
          WHERE f.status = 'active'
          ORDER BY fw.watched_at DESC NULLS LAST
          LIMIT 200`
      ),
      pool.query(
        `SELECT fp.friend_id, f.display_name AS friend_name, f.remote_instance_id, fp.now_playing
           FROM friend_profiles fp JOIN friends f ON f.id = fp.friend_id
          WHERE f.status = 'active'`
      ),
      pool.query(
        `SELECT w.id AS watch_id, w.tmdb_id, w.title, w.showtime, t.name AS theater_name, tc.payload AS tmdb,
                COALESCE((SELECT jsonb_agg(jsonb_build_object('name', se.author_name, 'body', se.body, 'at', se.created_at) ORDER BY se.created_at)
                            FROM social_events se WHERE se.watch_id = w.id AND se.kind = 'comment'), '[]'::jsonb) AS comments
           FROM watches w
           LEFT JOIN theaters t ON t.id = w.theater_id
           LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
          WHERE w.status = 'pending' AND w.showtime IS NOT NULL`
      ),
      fed.getIdentity(),
    ]);
    const myInstanceId = identity?.instance_id || null;

    const watchedItems = watched.rows.map((r) => {
      const p = r.payload || {};
      return {
        id: `${r.friend_id}:${p.remote_id}`,
        kind: 'watched',
        friend_id: r.friend_id,
        friend_name: r.friend_name,
        host_friend_id: r.friend_id,
        host_remote_id: p.remote_id,
        host_own_watch_id: null,
        title: p.tmdb?.title || p.title,
        poster_url: p.tmdb?.poster_url || null,
        release_year: p.tmdb?.release_year || null,
        director: p.tmdb?.director || null,
        rating: p.rating ?? null,
        comments: Array.isArray(p.comments) ? p.comments : [],
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
      // A peer-supplied showtime that's present but unparseable would throw in
      // matchKey (new Date(...).toISOString()) and take down the whole feed.
      if (Number.isNaN(Date.parse(p.showtime))) return;
      const k = matchKey(p);
      if (!groups.has(k)) groups.set(k, { p, people: [] });
      groups.get(k).people.push(who);
    };
    for (const r of profiles.rows) {
      for (const p of Array.isArray(r.now_playing) ? r.now_playing : []) {
        add(p, { friend_id: r.friend_id, name: r.friend_name, instance_id: r.remote_instance_id, p });
      }
    }
    for (const p of mine.rows) {
      add(p, { you: true, instance_id: myInstanceId, watch_id: p.watch_id, comments: p.comments });
    }

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
      // Canonical host for the shared thread: the participant whose instance id
      // sorts first. Everyone in a mutual group computes the same host, so all
      // comments converge on one thread. The host can be a friend or you.
      const host = people
        .filter((w) => w.instance_id)
        .sort((a, b) => (a.instance_id < b.instance_id ? -1 : 1))[0];
      const friendHost = host && !host.you ? host : null;
      const youHost = host && host.you ? host : null;
      const profileFriend = friends.length === 1 ? friends[0] : null;

      upcomingItems.push({
        id: `up:${k}`,
        kind: 'upcoming',
        together: people.length > 1,
        you: youIn,
        people: people.map((w) =>
          w.you ? { name: 'You', you: true } : { name: w.name, friend_id: w.friend_id }
        ),
        // Tapping the card opens a profile only when there's exactly one friend.
        friend_id: profileFriend ? profileFriend.friend_id : null,
        friend_name: profileFriend ? profileFriend.name : null,
        // The comment thread lives on the host's copy of the film.
        host_friend_id: friendHost ? friendHost.friend_id : null,
        host_remote_id: friendHost ? friendHost.p.remote_id : null,
        host_own_watch_id: youHost ? youHost.watch_id : null,
        comments: friendHost
          ? Array.isArray(friendHost.p.comments) ? friendHost.p.comments : []
          : youHost && Array.isArray(youHost.comments) ? youHost.comments : [],
        title: p.tmdb?.title || p.title,
        poster_url: p.tmdb?.poster_url || null,
        release_year: p.tmdb?.release_year || null,
        director: p.tmdb?.director || null,
        runtime_minutes: p.tmdb?.runtime_minutes || null,
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
    const [profRes, mineRes, theirsRes] = await Promise.all([
      pool.query(`SELECT stats, now_playing, fetched_at FROM friend_profiles WHERE friend_id = $1`, [req.params.id]),
      pool.query(
        `SELECT tmdb_id, MAX(rating) AS rating FROM watches
          WHERE status = 'watched' AND tmdb_id IS NOT NULL GROUP BY tmdb_id`
      ),
      pool.query(`SELECT payload FROM friend_watches WHERE friend_id = $1`, [req.params.id]),
    ]);

    // Taste match: films in common, and agreement among films you both rated.
    const mine = new Map(mineRes.rows.map((r) => [r.tmdb_id, r.rating]));
    const theirs = new Map();
    for (const row of theirsRes.rows) {
      const p = row.payload || {};
      if (p.tmdb_id) theirs.set(p.tmdb_id, p.rating ?? null);
    }
    let inCommon = 0;
    let bothRated = 0;
    let agree = 0;
    for (const [id, myRating] of mine) {
      if (!theirs.has(id)) continue;
      inCommon++;
      const theirRating = theirs.get(id);
      if (myRating != null && theirRating != null) {
        bothRated++;
        if (Math.abs(myRating - theirRating) <= 1) agree++;
      }
    }
    const taste = {
      in_common: inCommon,
      rated_in_common: bothRated,
      agreement_pct: bothRated >= 3 ? Math.round((agree / bothRated) * 100) : null,
    };

    res.json({ ...friendRes.rows[0], ...(profRes.rows[0] || {}), taste });
  } catch (err) {
    logger.error({ err }, 'friend profile');
    res.status(500).json({ error: 'Server error' });
  }
});

// Push to a friend's federation endpoint, signed with our outbound token.
async function sendToFriend(friendId, path, payload) {
  const { rows } = await pool.query(
    `SELECT base_url, outbound_token FROM friends WHERE id = $1 AND status = 'active'`,
    [friendId]
  );
  if (!rows.length) return { status: 404 };
  const f = rows[0];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const resp = await fetch(`${f.base_url.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${f.outbound_token}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    return { status: resp.ok ? 200 : 502 };
  } catch {
    return { status: 502 };
  } finally {
    clearTimeout(timer);
  }
}

// POST /api/friends/:id/comment { remote_watch_id, text } — comment on a friend's film.
router.post('/:id/comment', async (req, res) => {
  try {
    const { remote_watch_id, text } = req.body || {};
    if (!remote_watch_id || !(text || '').trim()) {
      return res.status(400).json({ error: 'remote_watch_id and text required' });
    }
    const r = await sendToFriend(req.params.id, '/api/federation/inbox', {
      kind: 'comment',
      target_watch_id: remote_watch_id,
      body: text,
    });
    if (r.status !== 200) return res.status(r.status).json({ error: 'Could not reach friend' });
    federationSync.syncFriendById(req.params.id).catch(() => {});
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'comment');
    res.status(500).json({ error: 'Server error' });
  }
});

// POST /api/friends/:id/recommend { tmdb_id, title } — recommend a film to a friend.
router.post('/:id/recommend', async (req, res) => {
  try {
    const { tmdb_id, title } = req.body || {};
    if (!tmdb_id && !title) return res.status(400).json({ error: 'tmdb_id or title required' });
    const r = await sendToFriend(req.params.id, '/api/federation/recommend', { tmdb_id, title });
    if (r.status !== 200) return res.status(r.status).json({ error: 'Could not reach friend' });
    res.json({ ok: true });
  } catch (err) {
    logger.error({ err }, 'recommend');
    res.status(500).json({ error: 'Server error' });
  }
});

// GET /api/friends/:id/common — films you and this friend have both watched,
// with both ratings.
router.get('/:id/common', async (req, res) => {
  try {
    const [mineRes, theirsRes] = await Promise.all([
      pool.query(
        `SELECT DISTINCT ON (w.tmdb_id) w.tmdb_id, w.rating,
                tc.payload->>'title' AS title,
                tc.payload->>'poster_url' AS poster_url,
                tc.payload->>'release_year' AS release_year
           FROM watches w LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
          WHERE w.status = 'watched' AND w.tmdb_id IS NOT NULL
          ORDER BY w.tmdb_id, w.rating DESC NULLS LAST`
      ),
      pool.query(`SELECT payload FROM friend_watches WHERE friend_id = $1`, [req.params.id]),
    ]);

    const theirs = new Map();
    for (const row of theirsRes.rows) {
      const p = row.payload || {};
      if (p.tmdb_id && !theirs.has(p.tmdb_id)) {
        theirs.set(p.tmdb_id, { rating: p.rating ?? null, title: p.tmdb?.title, poster_url: p.tmdb?.poster_url });
      }
    }

    const films = [];
    for (const m of mineRes.rows) {
      const t = theirs.get(m.tmdb_id);
      if (!t) continue;
      films.push({
        tmdb_id: m.tmdb_id,
        title: m.title || t.title || `TMDB ${m.tmdb_id}`,
        poster_url: m.poster_url || t.poster_url || null,
        release_year: m.release_year || null,
        my_rating: m.rating ?? null,
        their_rating: t.rating ?? null,
      });
    }
    // Co-rated first, then by title.
    films.sort((a, b) => {
      const ar = a.my_rating != null && a.their_rating != null ? 0 : 1;
      const br = b.my_rating != null && b.their_rating != null ? 0 : 1;
      return ar - br || (a.title || '').localeCompare(b.title || '');
    });
    res.json(films);
  } catch (err) {
    logger.error({ err }, 'friend common films');
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
