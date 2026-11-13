// The owner's side of Now Playing: which theatres they follow, and which of
// the films on today's board are already in their diary or booked.

const { pool } = require('../db');
const logger = require('../logger');
const jobStatus = require('./job-status');
const fandango = require('./fandango');
const tmdb = require('./tmdb');
const { normalizeText, cleanTitle } = require('../utils/normalize');

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
      `SELECT w.id, w.title, w.status, w.showtime, tc.payload->>'title' AS tmdb_title
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
      const entry = { watch_id: w.id, showtime: w.showtime };
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
      booked: b ? { watch_id: b.watch_id, showtime: b.showtime } : null,
    };
  });
}

// ---------- posters ----------

const UNSEEN_ART = { screen: '/screen-unseen.avif', scream: '/scream-unseen.avif' };
const POSTER_HIT_MS = 7 * 24 * 60 * 60 * 1000;
const POSTER_MISS_MS = 6 * 60 * 60 * 1000;
const MAX_POSTERS = 500;
const posterCache = new Map();

// TMDB's poster for a film the showtimes source has none for. Only a result
// with the same title counts: a blank poster is better than the wrong film's.
async function tmdbPoster(title, year) {
  const want = titleKey(title);
  // Without a TMDB key there is nothing to ask, and no reason to log it per film.
  if (!want || !process.env.TMDB_API_KEY) return null;
  const key = `${want}|${year || ''}`;
  const hit = posterCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;

  const promise = (async () => {
    const results = await tmdb.search(cleanTitle(title));
    const same = results.filter(
      (r) => r.poster_url && (titleKey(r.title) === want || titleKey(r.original_title) === want)
    );
    const top = tmdb.rankResults(same, { year: year || undefined })[0];
    if (!top) return null;
    if (year && top.release_year != null && Math.abs(top.release_year - year) > 1) return null;
    // The list shows posters at thumbnail size.
    return top.poster_url.replace('/t/p/w500/', '/t/p/w185/');
  })();

  const entry = { promise, expires: Date.now() + POSTER_HIT_MS };
  posterCache.set(key, entry);
  promise.then(
    (url) => {
      if (!url) entry.expires = Date.now() + POSTER_MISS_MS;
    },
    () => {
      if (posterCache.get(key) === entry) posterCache.delete(key);
    }
  );
  if (posterCache.size > MAX_POSTERS) posterCache.delete(posterCache.keys().next().value);
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
  flagFilms,
  fillPosters,
  tmdbPoster,
  clearPosterCache,
  recordSuccess,
  recordFailure,
  _internal: { cleanTheatres, titleKey, unseenKeyFromTitle, unseenKeyFromWatch },
};
