const { pool } = require('../db');
const { notify } = require('./notifications');

// Strict match: same film (tmdb id, else normalized title) + theatre + minute.
const norm = (s) => (s || '').trim().toLowerCase();
const filmKey = (p) => (p.tmdb_id ? `t:${p.tmdb_id}` : `n:${norm(p.tmdb?.title || p.title)}`);
const matchKey = (p) =>
  `${filmKey(p)}|${norm(p.theater_name)}|${new Date(p.showtime).toISOString().slice(0, 16)}`;

// matchKey throws on a truthy-but-unparseable showtime, and peer feeds are
// arbitrary input — every consumer must gate on this first.
const validShowing = (p) =>
  p && p.showtime && p.theater_name && !Number.isNaN(Date.parse(p.showtime));

function fmtShow(iso) {
  if (!iso) return '';
  // Showtimes are stored as wall-clock labelled UTC, so format in UTC to recover
  // the printed local time.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}

// All current "seeing together" matches: a showing with 2+ people (friends, or
// friends + you) sharing the same film/theatre/showtime.
async function computeMatches() {
  const [profiles, mine] = await Promise.all([
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

  const groups = new Map();
  const add = (p, who) => {
    if (!validShowing(p)) return;
    const k = matchKey(p);
    if (!groups.has(k)) groups.set(k, { key: k, p, people: [] });
    groups.get(k).people.push(who);
  };
  for (const r of profiles.rows) {
    for (const p of Array.isArray(r.now_playing) ? r.now_playing : []) {
      add(p, { friend_id: r.friend_id, name: r.friend_name });
    }
  }
  for (const p of mine.rows) add(p, { you: true });

  const out = [];
  for (const g of groups.values()) {
    const seen = new Set();
    const people = g.people.filter((w) => {
      const id = w.you ? 'you' : w.friend_id;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (people.filter((w) => !w.you).length === 0) continue; // your-only — not a match
    if (people.length < 2) continue; // need 2+ people
    out.push({ key: g.key, p: g.p, people });
  }
  return out;
}

// Match keys we've already announced this process lifetime. The notifications
// table also dedupes by key, but the owner can "Clear all" — which would let the
// same still-upcoming match re-announce on the next sync. This in-memory guard
// survives a clear; keys are forgotten once the match is no longer live so a
// genuinely new future match can announce again.
const announced = new Set();

// Notify for any matches not already announced (deduped by the match key).
async function notifyNewMatches() {
  const matches = await computeMatches();
  const live = new Set();
  for (const m of matches) {
    live.add(m.key);
    if (announced.has(m.key)) continue;
    const film = m.p.tmdb?.title || m.p.title;
    const youIn = m.people.some((w) => w.you);
    const friendNames = m.people.filter((w) => !w.you).map((w) => w.name);
    const join = (ns) =>
      ns.length <= 1 ? ns[0] || '' : `${ns.slice(0, -1).join(', ')} & ${ns[ns.length - 1]}`;
    const title = youIn
      ? `You're seeing ${film} with ${join(friendNames)}`
      : `${join(friendNames)} are seeing ${film} together`;
    await notify({
      kind: 'together',
      title,
      body: `${fmtShow(m.p.showtime)} · ${m.p.theater_name}`,
      payload: { key: m.key, film },
      dedupeKey: `together:${m.key}`,
    });
    announced.add(m.key);
  }
  for (const k of announced) if (!live.has(k)) announced.delete(k);
}

// A friend's brand-new reservations, detected by diffing their cached
// now_playing against the fresh pull. Skips the first-ever sync (everything
// would look new) and any showing that matches one of YOUR pending
// reservations — notifyNewMatches announces those as "seeing together".
async function notifyNewBookings(friend, oldList, newList) {
  if (!Array.isArray(oldList)) return;
  const oldKeys = new Set(oldList.filter(validShowing).map(matchKey));
  const fresh = (Array.isArray(newList) ? newList : []).filter(validShowing).filter((p) => !oldKeys.has(matchKey(p)));
  if (!fresh.length) return;

  const mine = await pool.query(
    `SELECT w.tmdb_id, w.title, w.showtime, t.name AS theater_name, tc.payload AS tmdb
       FROM watches w
       LEFT JOIN theaters t ON t.id = w.theater_id
       LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
      WHERE w.status = 'pending' AND w.showtime IS NOT NULL`
  );
  const myKeys = new Set(mine.rows.filter(validShowing).map(matchKey));

  const name = friend.display_name || 'A friend';
  for (const p of fresh) {
    const k = matchKey(p);
    if (myKeys.has(k)) continue;
    await notify({
      kind: 'booked',
      title: `${name} booked ${p.tmdb?.title || p.title}`,
      body: `${fmtShow(p.showtime)} · ${p.theater_name}`,
      payload: { friend_id: friend.id },
      dedupeKey: `booked:${friend.id}:${k}`,
    });
  }
}

module.exports = { computeMatches, notifyNewMatches, notifyNewBookings };
