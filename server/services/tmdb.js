const { pool } = require('../db');
const { cleanTitle, isRerelease } = require('../utils/normalize');

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

  let res = await fetch(url);
  // Honour a single Retry-After backoff on rate-limit before giving up, so a
  // 429 burst doesn't surface as a hard failure (which would burn rechecker
  // retries). Capped so we never stall a request for long.
  if (res.status === 429) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 1, 10);
    await new Promise((r) => setTimeout(r, wait * 1000));
    res = await fetch(url);
  }
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
    release_date: r.release_date || null,
    poster_url: r.poster_path ? POSTER_BASE + r.poster_path : null,
    overview: r.overview,
    popularity: r.popularity,
  };
}

// Films currently in US theaters (plus the nearest upcoming) for the
// watchlist's discovery feed. now_playing runs many pages — one page misses
// most of what's out — so pull several and rank by popularity so the
// recognizable releases surface first. Deduped; poster required.
async function nowPlaying() {
  const reqs = [
    tmdbFetch('/movie/now_playing', { region: 'US', page: 1 }),
    tmdbFetch('/movie/now_playing', { region: 'US', page: 2 }),
    tmdbFetch('/movie/now_playing', { region: 'US', page: 3 }),
    tmdbFetch('/movie/upcoming', { region: 'US', page: 1 }),
  ];
  // Tolerate a single page failing — a partial feed beats no feed at all.
  const settled = await Promise.allSettled(reqs);
  const pages = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  if (!pages.length) throw new Error('TMDB now_playing: all pages failed');
  // now_playing is broad and noisy: it leaks old catalog/re-release records
  // (a 1999 Fight Club) and a long tail of tiny limited releases that never
  // hit a multiplex. Keep only recent films above a notability floor so the
  // feed reads like an actual marquee. TMDB is the only source here — there's
  // no public AMC showtimes API to cross-check against.
  const minYear = new Date().getUTCFullYear() - 1;
  const MIN_POPULARITY = 10;
  const seen = new Set();
  const out = [];
  for (const data of pages) {
    for (const r of data.results || []) {
      if (!r.poster_path || seen.has(r.id)) continue;
      if ((r.popularity || 0) < MIN_POPULARITY) continue;
      const year = r.release_date ? Number(r.release_date.slice(0, 4)) : null;
      if (!year || year < minYear) continue;
      seen.add(r.id);
      out.push(shapeSearchResult(r));
    }
  }
  out.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
  return out;
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

// Anything released more than this many years after the watch can't be the
// film that was screened — a year of slack absorbs late-December releases seen
// in early January and festival/preview runs.
const FUTURE_TOLERANCE = 1;

// Order search results for a watch seen in `year`: rank candidates released
// on/near that year ahead of distant ones, and sink anything released well
// after the watch. Falls back to popularity when no year is known or the title
// is a re-release (where "nearest the showtime" would wrongly prefer a remake).
function rankResults(results, { year, rerelease } = {}) {
  const byPopularity = (a, b) => (b.popularity || 0) - (a.popularity || 0);
  if (!year || rerelease) return [...results].sort(byPopularity);
  const distance = (r) => (r.release_year == null ? Infinity : Math.abs(year - r.release_year));
  const isFuture = (r) => r.release_year != null && r.release_year > year + FUTURE_TOLERANCE;
  return [...results].sort((a, b) => {
    const fa = isFuture(a);
    const fb = isFuture(b);
    if (fa !== fb) return fa ? 1 : -1;
    const da = distance(a);
    const db = distance(b);
    if (da !== db) return da - db;
    return byPopularity(a, b);
  });
}

// Pick the best match for a title. `opts.year` is the year the film was seen
// (from showtime / watched_at); when present it biases the pick toward a
// release of that vintage. Returns { tmdb_id, needs_review, details } or null.
async function autoMatch(title, opts = {}) {
  // Strip AMC's format/language suffixes ("in RealD 3D", "Japanese Spoken with English
  // Subtitles", etc.) so TMDB search doesn't waste cycles on the format string.
  const cleaned = cleanTitle(title);
  const results = await search(cleaned);
  if (results.length === 0) return null;
  const ranked = rankResults(results, { year: opts.year, rerelease: isRerelease(title) });
  const top = ranked[0];
  const details = await getOrFetchDetails(top.tmdb_id);
  const needs_review =
    ranked.length > 1 &&
    (ranked[1].popularity || 0) > 0.5 * (top.popularity || 0) &&
    similarity(top.title, cleaned) < 0.85;
  return { tmdb_id: top.tmdb_id, needs_review, details };
}

// Year from a showtime / watched_at value, or undefined when absent/invalid.
function yearOf(dateish) {
  if (!dateish) return undefined;
  const d = new Date(dateish);
  return Number.isNaN(d.getTime()) ? undefined : d.getUTCFullYear();
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

module.exports = { search, getOrFetchDetails, autoMatch, rankResults, yearOf, nowPlaying };
