// The owner's side of Now Playing: which theatres they follow, and which of
// the films on today's board are already in their diary or booked.

const { pool } = require('../db');
const logger = require('../logger');
const jobStatus = require('./job-status');
const fandango = require('./fandango');
const tmdb = require('./tmdb');
const { simpleParser } = require('mailparser');
const { load, bodyText } = require('../parsers/util');
const { normalizeText, cleanTitle, isRerelease } = require('../utils/normalize');

const STATE_KEY = 'now_playing_theatres';
const MAX_SAVED = 12;
const JOB = 'showtimes';

function cleanTheatre(t) {
  if (!t || typeof t !== 'object' || !fandango.THEATRE_ID.test(String(t.id || ''))) return null;
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const name = text(t.name, 120);
  if (!name) return null;
  return {
    id: String(t.id).toUpperCase(),
    name,
    city: text(t.city, 80),
    state: text(t.state, 20),
  };
}

// { home, saved }: home is one theatre or null, saved is the rest of the list.
function cleanTheatres(input) {
  const home = cleanTheatre(input && input.home);
  const saved = [];
  for (const raw of Array.isArray(input && input.saved) ? input.saved : []) {
    const t = cleanTheatre(raw);
    if (!t || (home && t.id === home.id) || saved.some((s) => s.id === t.id)) continue;
    saved.push(t);
    if (saved.length >= MAX_SAVED) break;
  }
  return { home, saved };
}

async function getTheatres() {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [STATE_KEY]);
  if (!rows[0]) return { home: null, saved: [] };
  try {
    return cleanTheatres(JSON.parse(rows[0].value));
  } catch {
    return { home: null, saved: [] };
  }
}

async function setTheatres(input) {
  const value = cleanTheatres(input);
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [STATE_KEY, JSON.stringify(value)]
  );
  return value;
}

// ---------- theatres from the diary ----------

const VISITED_KEY = 'now_playing_visited';
const RETRY_LOOKUP_MS = 10 * 60 * 1000;
const MAX_TOWNS = 4;
let lookupFailedAt = 0;

async function readVisitedMap() {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [VISITED_KEY]);
  if (!rows[0]) return {};
  try {
    const parsed = JSON.parse(rows[0].value);
    const out = {};
    for (const [name, t] of Object.entries(parsed || {})) {
      const clean = cleanTheatre(t);
      if (clean) out[name] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

// The ZIP printed after a theatre's name in a reservation email:
//   "AMC Monmouth Mall 15 180 Rt 35 Eatontown, NJ 07724"
// The first comma after the name has to be the one before the state, which
// keeps out a Thank You email, where the name is followed by other text and
// then AMC's own office address.
function zipAfterName(text, name) {
  const body = String(text || '').replace(/\s+/g, ' ');
  let from = 0;
  for (;;) {
    const at = body.indexOf(name, from);
    if (at === -1) return null;
    const m = /^\s*[^,]{3,80},\s*[A-Z]{2}\s+(\d{5})\b/.exec(body.slice(at + name.length, at + name.length + 140));
    if (m) return m[1];
    from = at + name.length;
  }
}

// Where a diary theatre is, read from the reservation emails for films seen
// there. Null when it was only ever entered by hand.
async function zipFromEmails(theatreName) {
  const { rows } = await pool.query(
    `SELECT el.raw_html
       FROM theaters t
       JOIN watches w ON w.theater_id = t.id
       JOIN email_log el ON el.gmail_message_id = w.reservation_email_id
      WHERE t.name = $1
      ORDER BY el.received_at DESC
      LIMIT 3`,
    [theatreName]
  );
  for (const r of rows) {
    try {
      const mail = await simpleParser(r.raw_html);
      const html = mail.html || mail.textAsHtml || '';
      const zip = zipAfterName(bodyText(load(html)) || mail.text, theatreName);
      if (zip) return zip;
    } catch {
      /* an email that will not parse just has no address to offer */
    }
  }
  return null;
}

// The theatres the owner has watched films at, most visited first, each tied
// to its listing so its showtimes can be opened. The diary only knows a
// theatre by the name in AMC's emails and the showtimes source can only be
// searched by place. So each one is looked up by the ZIP its reservation
// emails print, which needs no home theatre and finds one visited on a trip.
// A match is kept for good.
async function visitedTheatres({ home, saved }) {
  const { rows } = await pool.query(
    `SELECT t.name, COUNT(*)::int AS visits
       FROM theaters t
       JOIN watches w ON w.theater_id = t.id
      WHERE w.status = 'watched'
      GROUP BY t.id, t.name
      ORDER BY visits DESC, MAX(COALESCE(w.watched_at, w.showtime)) DESC NULLS LAST`
  );
  if (!rows.length) return [];

  const known = await readVisitedMap();
  for (const t of [home, ...saved].filter(Boolean)) known[normalizeText(t.name)] = t;

  const isMissing = (r) => !known[normalizeText(r.name)];
  if (rows.some(isMissing) && Date.now() - lookupFailedAt > RETRY_LOOKUP_MS) {
    let found = false;
    const take = (near) => {
      const byName = new Map(near.map((t) => [normalizeText(t.name), t]));
      for (const r of rows.filter(isMissing)) {
        const hit = cleanTheatre(byName.get(normalizeText(r.name)));
        if (!hit) continue;
        known[normalizeText(r.name)] = hit;
        found = true;
      }
    };
    try {
      // One search usually settles several: a ZIP's results are the AMCs
      // around it, and a person's theatres tend to be near each other.
      for (const r of rows) {
        if (!isMissing(r)) continue;
        const zip = await zipFromEmails(r.name);
        if (zip) take(await fandango.searchTheatres(zip));
      }
      // A search only reaches about fifteen miles, so one entered by hand is
      // tried against the towns of the theatres already placed, home first.
      const towns = [...new Set([home, ...Object.values(known)].filter((t) => t && t.city && t.state).map((t) => `${t.city}, ${t.state}`))];
      for (const town of towns.slice(0, MAX_TOWNS)) {
        if (!rows.some(isMissing)) break;
        take(await fandango.searchTheatres(town));
      }
      // Whatever is still unmatched is not asked about again for a while.
      if (rows.some(isMissing)) lookupFailedAt = Date.now();
    } catch (err) {
      lookupFailedAt = Date.now();
      logger.warn(`now-playing: could not look up the diary's theatres: ${err.message}`);
    }
    if (found) {
      await pool.query(
        `INSERT INTO app_state (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [VISITED_KEY, JSON.stringify(known)]
      );
    }
  }

  const out = [];
  for (const r of rows) {
    const t = known[normalizeText(r.name)];
    if (t && !out.some((o) => o.id === t.id)) out.push({ ...t, visits: r.visits });
  }
  return out;
}

// What the Now Playing tab opens with: the saved theatres plus the diary's.
// The diary's list is a convenience, so a failure there never hides the rest.
async function theatresForView(settings) {
  const base = settings || (await getTheatres());
  try {
    return { ...base, visited: await visitedTheatres(base) };
  } catch (err) {
    logger.error({ err }, "now-playing: could not list the diary's theatres");
    return { ...base, visited: [] };
  }
}

const titleKey = (title) => normalizeText(cleanTitle(title || ''));

const UNSEEN = /amc\s+(screen|scream)\s+unseen/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// "screen" or "scream" for a mystery screening, else null.
function unseenKind(title) {
  const m = UNSEEN.exec(title || '');
  return m ? m[1].toLowerCase() : null;
}

// The listing says "AMC Screen Unseen: November 16" and the reservation email
// words it differently, so the two are matched on which Unseen and which day.
function unseenKeyFromTitle(title) {
  const kind = unseenKind(title);
  const m = kind && /unseen\W+([a-z]{3})[a-z]*\W+(\d{1,2})\b/i.exec(title);
  const month = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  return month === -1 ? null : `unseen:${kind}:${month + 1}-${Number(m[2])}`;
}

// Showtimes are stored as the theatre's clock labelled UTC, so the UTC parts
// are the local date.
function unseenKeyFromWatch(w) {
  const kind = unseenKind(w.title);
  const d = kind && w.showtime ? new Date(w.showtime) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return `unseen:${kind}:${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
}

// Marks each film the owner has already seen or has a ticket for. A booking is
// matched on the title AMC sold it under and never on the TMDB match: a Screen
// Unseen that has been identified early would otherwise show up as "Booked"
// against the real film and give the mystery away.
async function flagFilms(films) {
  if (!films.length) return films;
  let rows = [];
  try {
    ({ rows } = await pool.query(
      `SELECT w.id, w.title, w.status, w.showtime, w.auditorium, w.seats, tc.payload->>'title' AS tmdb_title
         FROM watches w
         LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
        WHERE w.status IN ('watched', 'pending')`
    ));
  } catch (err) {
    logger.error({ err }, 'now-playing: could not read the diary for seen flags');
    return films;
  }
  const seen = new Map();
  const booked = new Map();
  for (const w of rows) {
    if (w.status === 'watched') {
      for (const t of [w.title, w.tmdb_title]) {
        const k = titleKey(t);
        if (k) seen.set(k, w.id);
      }
    } else {
      const entry = { watch_id: w.id, showtime: w.showtime, auditorium: w.auditorium || null, seats: w.seats || [] };
      const k = titleKey(w.title);
      if (k) booked.set(k, entry);
      const u = unseenKeyFromWatch(w);
      if (u) booked.set(u, entry);
    }
  }
  return films.map((f) => {
    const k = titleKey(f.title);
    const b = booked.get(k) || booked.get(unseenKeyFromTitle(f.title));
    return {
      ...f,
      seen_watch_id: seen.get(k) || null,
      booked: b || null,
    };
  });
}

// ---------- posters ----------

const UNSEEN_ART = { screen: '/screen-unseen.avif', scream: '/scream-unseen.avif' };
const POSTER_HIT_MS = 7 * 24 * 60 * 60 * 1000;
const POSTER_MISS_MS = 6 * 60 * 60 * 1000;
const MAX_POSTERS = 500;
const posterCache = new Map();

// The TMDB film a listing is, or null. Only a result with the same title
// counts, and within a year of the listing's when it gives one: no answer is
// better than the wrong film's poster or synopsis. Answers are remembered.
function tmdbMatch(title, year, { needPoster = false } = {}) {
  const want = titleKey(title);
  // Without a TMDB key there is nothing to ask, and no reason to log it per film.
  if (!want || !process.env.TMDB_API_KEY) return Promise.resolve(null);
  const key = `${want}|${year || ''}|${needPoster ? 'p' : ''}`;
  const hit = posterCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;

  const promise = (async () => {
    const results = await tmdb.search(cleanTitle(title));
    const same = results.filter(
      (r) => (!needPoster || r.poster_url) && (titleKey(r.title) === want || titleKey(r.original_title) === want)
    );
    // A re-release is listed under this year but is the film from its first
    // run, so the year says nothing and the best-known film of that title wins.
    const rerelease = isRerelease(title);
    const top = tmdb.rankResults(same, { year: year || undefined, rerelease })[0];
    if (!top) return null;
    if (!rerelease && year && top.release_year != null && Math.abs(top.release_year - year) > 1) return null;
    return top;
  })();

  const entry = { promise, expires: Date.now() + POSTER_HIT_MS };
  posterCache.set(key, entry);
  promise.then(
    (found) => {
      if (!found) entry.expires = Date.now() + POSTER_MISS_MS;
    },
    () => {
      if (posterCache.get(key) === entry) posterCache.delete(key);
    }
  );
  if (posterCache.size > MAX_POSTERS) posterCache.delete(posterCache.keys().next().value);
  return promise;
}

// TMDB's poster for a film the showtimes source has none for.
async function tmdbPoster(title, year) {
  const match = await tmdbMatch(title, year, { needPoster: true });
  // The list shows posters at thumbnail size.
  return match ? match.poster_url.replace('/t/p/w500/', '/t/p/w185/') : null;
}

const INFO_MS = 24 * 60 * 60 * 1000;
const infoCache = new Map();

// Synopsis, cast, score and trailer for the film sheet, or null when the film
// cannot be placed. An Unseen is never looked up: its listing says nothing,
// and finding out what it is would be the spoiler.
async function filmInfo(title, year) {
  if (unseenKind(title)) return null;
  const match = await tmdbMatch(title, year);
  if (!match) return null;
  const hit = infoCache.get(match.tmdb_id);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = tmdb.filmInfo(match.tmdb_id);
  const entry = { promise, expires: Date.now() + INFO_MS };
  infoCache.set(match.tmdb_id, entry);
  promise.catch(() => {
    if (infoCache.get(match.tmdb_id) === entry) infoCache.delete(match.tmdb_id);
  });
  if (infoCache.size > MAX_POSTERS) infoCache.delete(infoCache.keys().next().value);
  return promise;
}

// An Unseen gets the app's own artwork, the same as in the diary. Any other
// film without a poster is looked up on TMDB. A lookup that fails leaves the
// film as it was: posters never hold up the showtimes.
async function fillPosters(films) {
  return Promise.all(
    films.map(async (f) => {
      const kind = unseenKind(f.title);
      if (kind) return { ...f, unseen: kind, poster_url: UNSEEN_ART[kind] };
      if (f.poster_url) return f;
      try {
        return { ...f, poster_url: await tmdbPoster(f.title, f.year) };
      } catch (err) {
        logger.warn(`now-playing: no TMDB poster for "${f.title}": ${err.message}`);
        return f;
      }
    })
  );
}

function clearPosterCache() {
  posterCache.clear();
  infoCache.clear();
}

// Successes are frequent and all alike, so only one in five minutes is written
// down. Failures always are.
const RECORD_EVERY_MS = 5 * 60 * 1000;
let lastRecorded = 0;

function recordSuccess(detail) {
  const now = Date.now();
  if (now - lastRecorded < RECORD_EVERY_MS) return;
  lastRecorded = now;
  jobStatus.succeeded(JOB, detail);
}

function recordFailure(err) {
  // A bad theatre id or an expired showing is the caller's mistake, not the
  // source breaking.
  if (err && err.status && err.status < 500) return;
  lastRecorded = 0;
  jobStatus.failed(JOB, err);
}

module.exports = {
  JOB,
  getTheatres,
  setTheatres,
  unseenKind,
  theatresForView,
  flagFilms,
  fillPosters,
  tmdbPoster,
  filmInfo,
  clearPosterCache,
  recordSuccess,
  recordFailure,
  _internal: { cleanTheatres, visitedTheatres, zipAfterName, resetLookupBackoff: () => (lookupFailedAt = 0), titleKey, unseenKeyFromTitle, unseenKeyFromWatch },
};
