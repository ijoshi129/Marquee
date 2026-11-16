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

// Films opening in US cinemas between two dates, best known first. Pass a
// certification to keep only films TMDB lists with that US rating.
async function discoverOpening({ from, to, certification }) {
  const params = {
    region: 'US',
    'release_date.gte': from,
    'release_date.lte': to,
    with_release_type: '2|3',
    sort_by: 'popularity.desc',
    include_adult: 'false',
  };
  if (certification) {
    params.certification_country = 'US';
    params.certification = certification;
  }
  const data = await tmdbFetch('/discover/movie', params);
  return (data.results || []).map((r) => ({ ...shapeSearchResult(r), genre_ids: r.genre_ids || [] }));
}

// When and how a film opens in the US, with its runtime and makers. The
// release date on a film's main record is its first anywhere, which for a
// festival film is months before it reaches a cinema here.
async function releaseFacts(tmdbId) {
  const data = await tmdbFetch(`/movie/${tmdbId}`, { append_to_response: 'release_dates' });
  const us = (data.release_dates?.results || []).find((r) => r.iso_3166_1 === 'US');
  const dates = us ? us.release_dates : [];
  const day = (d) => String(d.release_date || '').slice(0, 10);
  const theatrical = dates.filter((d) => d.type === 2 || d.type === 3).map((d) => ({ date: day(d), type: d.type }));
  return {
    tmdb_id: data.id,
    title: data.title,
    first_release: data.release_date || null,
    runtime_minutes: data.runtime || null,
    genres: (data.genres || []).map((g) => g.name),
    companies: (data.production_companies || []).map((c) => c.name),
    poster_url: data.poster_path ? POSTER_BASE + data.poster_path : null,
    us_dates: theatrical.filter((d) => d.date).sort((a, b) => a.date.localeCompare(b.date)),
    us_ratings: [...new Set(dates.map((d) => d.certification).filter(Boolean))],
  };
}

// The official trailer if there is one, else any trailer, else a teaser.
function pickTrailer(videos) {
  const onYouTube = (videos || []).filter((v) => v && v.site === 'YouTube' && v.key);
  const rank = (v) => (v.type === 'Trailer' ? 0 : v.type === 'Teaser' ? 2 : 4) + (v.official ? 0 : 1);
  const best = onYouTube.filter((v) => v.type === 'Trailer' || v.type === 'Teaser').sort((a, b) => rank(a) - rank(b))[0];
  return best ? `https://www.youtube.com/watch?v=${best.key}` : null;
}

// Everything the film sheet in Now Playing shows. Kept apart from the diary's
// cached details: this is for films the owner has not seen, and it carries the
// cast, score and trailer that the diary has no use for.
async function filmInfo(tmdbId) {
  const data = await tmdbFetch(`/movie/${tmdbId}`, { append_to_response: 'credits,videos' });
  const crew = data.credits?.crew || [];
  const cast = (data.credits?.cast || [])
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, 6)
    .map((c) => ({ name: c.name, character: c.character || null }));
  return {
    tmdb_id: data.id,
    title: data.title,
    tagline: data.tagline || null,
    overview: data.overview || null,
    release_date: data.release_date || null,
    runtime_minutes: data.runtime || null,
    genres: (data.genres || []).map((g) => g.name),
    directors: crew.filter((c) => c.job === 'Director').map((c) => c.name),
    cast,
    score: data.vote_count >= 10 && data.vote_average ? Math.round(data.vote_average * 10) / 10 : null,
    votes: data.vote_count || 0,
    poster_url: data.poster_path ? POSTER_BASE + data.poster_path : null,
    backdrop_url: data.backdrop_path ? `https://image.tmdb.org/t/p/w780${data.backdrop_path}` : null,
    trailer_url: pickTrailer(data.videos?.results),
    tmdb_url: `https://www.themoviedb.org/movie/${data.id}`,
  };
}

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

module.exports = {
  search,
  getOrFetchDetails,
  autoMatch,
  rankResults,
  yearOf,
  filmInfo,
  pickTrailer,
  discoverOpening,
  releaseFacts,
};
