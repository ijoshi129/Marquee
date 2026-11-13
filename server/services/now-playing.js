// The owner's side of Now Playing: which theatres they follow, and which of
// the films on today's board are already in their diary or booked.

const { pool } = require('../db');
const logger = require('../logger');
const jobStatus = require('./job-status');
const fandango = require('./fandango');
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
      const k = titleKey(w.title);
      if (k) booked.set(k, { watch_id: w.id, showtime: w.showtime });
    }
  }
  return films.map((f) => {
    const k = titleKey(f.title);
    const b = booked.get(k);
    return {
      ...f,
      seen_watch_id: seen.get(k) || null,
      booked: b ? { watch_id: b.watch_id, showtime: b.showtime } : null,
    };
  });
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
  recordSuccess,
  recordFailure,
  _internal: { cleanTheatres, titleKey },
};
