// Likely candidates for a Screen or Scream Unseen that has not happened yet.
//
// AMC publishes two things about a mystery screening: its rating and a
// runtime. The r/AMCsAList megathread adds the history of every past one.
// Checked against TMDB on 2026-11-16, that history is unusually regular: of 23
// Unseens, 13 opened in the US 11 days after the screening (the Friday of the
// following week), 6 opened 4 days after (that same Friday), and none opened
// more than 18 days after. So the question is small: which films with this
// rating open in the next three weeks, and whose runtime fits.
//
// These are guesses. Nothing here knows the answer.

const logger = require('../logger');
const tmdb = require('./tmdb');
const unseenLookup = require('./unseen-lookup');

const DAY = 24 * 60 * 60 * 1000;
const WINDOW_DAYS = 24;
const HORROR = 'Horror';

// How far AMC's stated runtime sits from the film's real one, as the
// megathread puts it: "usually within -7 to 17 mins of the actual time".
const STATED_SHORT_BY = 7;
const STATED_LONG_BY = 17;
const RUNTIME_SLACK = 6;

const MAX_DETAILS = 28;
const MAX_SHOWN = 6;
const CACHE_MS = 6 * 60 * 60 * 1000;
const cache = new Map();

const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function fmtRuntime(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(iso) {
  const [, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}`;
}

// The first day the film plays in US cinemas after the screening: its wide
// opening if that falls in the window, else a limited one.
function usOpening(facts, screening) {
  const after = facts.us_dates.filter((d) => d.date > screening);
  const wide = after.find((d) => d.type === 3);
  return (wide || after[0] || {}).date || null;
}

// How well one film fits, as points with the reasons in words. Null rules it
// out. The weights follow the history above: when a film opens says the most,
// the runtime next, and the rest only breaks ties.
function assess(facts, { screening, kind, rating, runtime, studios }) {
  const reasons = [];
  let points = 0;

  const isHorror = facts.genres.includes(HORROR);
  if (kind === 'scream' && !isHorror) return null;
  if (kind === 'screen' && isHorror) return null;

  // A re-release of an older film opens "this month" too, and is never it.
  if (facts.first_release && daysBetween(facts.first_release, screening) > 400) return null;

  const opens = usOpening(facts, screening);
  if (!opens) return null;
  const gap = daysBetween(screening, opens);
  if (gap < 1 || gap > WINDOW_DAYS) return null;
  if (gap >= 8 && gap <= 12) points += 40;
  else if (gap <= 7) points += 27;
  else points += 14;
  reasons.push(`Opens ${fmtDay(opens)}, ${gap} ${gap === 1 ? 'day' : 'days'} after`);

  if (rating) {
    if (facts.us_ratings.length && !facts.us_ratings.includes(rating)) return null;
    if (facts.us_ratings.includes(rating)) {
      points += 15;
      reasons.push(`Rated ${rating}`);
    } else {
      reasons.push('No rating listed yet');
    }
  }

  if (runtime && facts.runtime_minutes) {
    const over = runtime - facts.runtime_minutes;
    if (over >= -STATED_SHORT_BY && over <= STATED_LONG_BY) {
      points += 30 - Math.min(10, Math.abs(over - 5));
      reasons.push(`${fmtRuntime(facts.runtime_minutes)}, which fits AMC's ${fmtRuntime(runtime)}`);
    } else if (over >= -STATED_SHORT_BY - RUNTIME_SLACK && over <= STATED_LONG_BY + RUNTIME_SLACK) {
      points += 6;
      reasons.push(`${fmtRuntime(facts.runtime_minutes)}, a stretch for AMC's ${fmtRuntime(runtime)}`);
    } else {
      return null;
    }
  } else if (runtime) {
    points += 10;
    reasons.push('Runtime not listed yet');
  }

  const makers = facts.companies.map(norm);
  const past = Object.entries(studios || {}).find(([name]) => {
    const n = norm(name);
    return n.length > 2 && makers.some((m) => m === n || m.startsWith(`${n} `) || m.includes(` ${n}`));
  });
  if (past) {
    points += 8;
    reasons.push(`${past[0]} has supplied ${past[1] === 1 ? 'an Unseen' : `${past[1]} Unseens`} before`);
  }

  return { points, opens, reasons };
}

function fitOf(points) {
  if (points >= 78) return 'strong';
  if (points >= 58) return 'possible';
  return 'long';
}

async function build({ date, kind, rating: listed }) {
  let clues = null;
  try {
    clues = await unseenLookup.cluesFor(date, kind);
  } catch (err) {
    logger.warn(`unseen-guess: no clues from the megathread for ${date}: ${err.message}`);
  }
  const rating = (clues && clues.rating) || listed || null;
  const runtime = (clues && clues.runtime) || null;
  const basis = {
    rating,
    runtime_minutes: runtime,
    from_megathread: Boolean(clues && (clues.rating || clues.runtime)),
  };
  if (clues && clues.revealed) {
    return { basis, revealed: clues.revealed.title, candidates: [] };
  }

  if (!process.env.TMDB_API_KEY) return { basis, revealed: null, candidates: [], needs_key: true };

  const from = addDays(date, 1);
  const to = addDays(date, WINDOW_DAYS);
  // Rated films first, then the best known of everything opening: a small
  // film often has no rating on TMDB until the week it opens.
  const lists = await Promise.all([
    rating ? tmdb.discoverOpening({ from, to, certification: rating }) : Promise.resolve([]),
    tmdb.discoverOpening({ from, to }),
  ]);
  const seen = new Set();
  const pool = [];
  for (const film of [...lists[0], ...lists[1]]) {
    if (seen.has(film.tmdb_id)) continue;
    seen.add(film.tmdb_id);
    pool.push(film);
    if (pool.length >= MAX_DETAILS) break;
  }

  const context = { screening: date, kind, rating, runtime, studios: clues ? clues.studios : {} };
  const scored = [];
  await Promise.all(
    pool.map(async (film) => {
      try {
        const facts = await tmdb.releaseFacts(film.tmdb_id);
        const verdict = assess(facts, context);
        if (!verdict) return;
        // Being better known settles a tie and nothing more.
        const points = verdict.points + Math.min(6, Math.log10(1 + (film.popularity || 0)) * 3);
        scored.push({
          tmdb_id: facts.tmdb_id,
          title: facts.title,
          year: Number(verdict.opens.slice(0, 4)),
          opens: verdict.opens,
          runtime_minutes: facts.runtime_minutes,
          poster_url: facts.poster_url ? facts.poster_url.replace('/t/p/w500/', '/t/p/w185/') : null,
          fit: fitOf(points),
          reasons: verdict.reasons,
          points: Math.round(points),
        });
      } catch (err) {
        logger.warn(`unseen-guess: could not read film ${film.tmdb_id}: ${err.message}`);
      }
    })
  );
  scored.sort((a, b) => b.points - a.points || a.title.localeCompare(b.title));
  return { basis, revealed: null, candidates: scored.slice(0, MAX_SHOWN) };
}

async function guesses({ date, kind, rating }) {
  const key = `${date}|${kind}|${rating || ''}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.promise;
  const promise = build({ date, kind, rating });
  const entry = { promise, expires: Date.now() + CACHE_MS };
  cache.set(key, entry);
  promise.catch(() => {
    if (cache.get(key) === entry) cache.delete(key);
  });
  if (cache.size > 40) cache.delete(cache.keys().next().value);
  return promise;
}

function clearCache() {
  cache.clear();
}

module.exports = { guesses, clearCache, _internal: { assess, usOpening, fitOf } };
