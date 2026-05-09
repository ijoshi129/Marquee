const { pool } = require('../db');
const { cleanTitle } = require('../utils/normalize');

const TMDB_BASE = 'https://api.themoviedb.org/3';
const POSTER_BASE = 'https://image.tmdb.org/t/p/w500';

function key() {
  const k = process.env.TMDB_API_KEY;
  if (!k) throw new Error('TMDB_API_KEY not set');
  return k;
}

async function tmdbFetch(path, params = {}) {
  const url = new URL(TMDB_BASE + path);
  url.searchParams.set('api_key', key());
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`TMDB ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

async function search(query) {
  if (!query || !query.trim()) return [];
  const data = await tmdbFetch('/search/movie', { query, include_adult: 'false' });
  return (data.results || []).map(shapeSearchResult);
}

function shapeSearchResult(r) {
  return {
    tmdb_id: r.id,
    title: r.title,
    original_title: r.original_title,
    release_year: r.release_date ? Number(r.release_date.slice(0, 4)) : null,
    poster_url: r.poster_path ? POSTER_BASE + r.poster_path : null,
    overview: r.overview,
    popularity: r.popularity,
  };
}

async function fetchDetails(tmdbId) {
  const data = await tmdbFetch(`/movie/${tmdbId}`, { append_to_response: 'credits' });
  const director = (data.credits?.crew || []).find((c) => c.job === 'Director');
  return {
    tmdb_id: data.id,
    title: data.title,
    original_title: data.original_title,
    release_year: data.release_date ? Number(data.release_date.slice(0, 4)) : null,
    runtime_minutes: data.runtime || null,
    genres: (data.genres || []).map((g) => g.name),
    director: director ? director.name : null,
    poster_url: data.poster_path ? POSTER_BASE + data.poster_path : null,
    overview: data.overview,
  };
}

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

async function getOrFetchDetails(tmdbId) {
  const cached = await pool.query(
    'SELECT payload, fetched_at FROM tmdb_cache WHERE tmdb_id = $1',
    [tmdbId]
  );
  if (cached.rows.length) {
    const fetchedAt = new Date(cached.rows[0].fetched_at).getTime();
    if (Date.now() - fetchedAt < CACHE_TTL_MS) {
      return cached.rows[0].payload;
    }
  }

  const details = await fetchDetails(tmdbId);
  await pool.query(
    `INSERT INTO tmdb_cache (tmdb_id, payload, fetched_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (tmdb_id) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = NOW()`,
    [tmdbId, details]
  );
  return details;
}

// Auto-pick highest popularity. Returns { tmdb_id, needs_review, details } or null.
async function autoMatch(title) {
  // Strip AMC's format/language suffixes ("in RealD 3D", "Japanese Spoken with English
  // Subtitles", etc.) so TMDB search doesn't waste cycles on the format string.
  const cleaned = cleanTitle(title);
  const results = await search(cleaned);
  if (results.length === 0) return null;
  results.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  const top = results[0];
  const details = await getOrFetchDetails(top.tmdb_id);
  const needs_review =
    results.length > 1 &&
    (results[1].popularity || 0) > 0.5 * (top.popularity || 0) &&
    similarity(top.title, cleaned) < 0.85;
  return { tmdb_id: top.tmdb_id, needs_review, details };
}

function similarity(a, b) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;
  // Cheap Jaccard on character bigrams
  const bigrams = (s) => {
    const set = new Set();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const ax = bigrams(x);
  const bx = bigrams(y);
  let inter = 0;
  for (const g of ax) if (bx.has(g)) inter++;
  return inter / (ax.size + bx.size - inter || 1);
}

module.exports = { search, getOrFetchDetails, autoMatch };
