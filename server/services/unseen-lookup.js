// Resolve actual movie titles for AMC Screen/Scream Unseen watches by parsing
// r/AMCsAList megathreads. The current sticky megathread lists recent reveals as
// structured Markdown; older megathreads cover ranges (1-22, 23-31, ...) and are
// linked from the body.
//
// One Reddit fetch per ~12h per megathread, anonymous JSON API — well under any
// rate limit for our access pattern.

const { pool } = require('../db');
const logger = require('../logger');
const tmdb = require('./tmdb');

const REDDIT_UA = 'marquee/0.1 by /u/ishaan42';
const SEARCH_URL =
  'https://www.reddit.com/r/AMCsAList/search.json?q=screen+unseen+megathread&restrict_sr=1&sort=new&t=year';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
// postId → { entries, predecessorUrls, fetchedAt }
const threadCache = new Map();
let currentMegathreadCache = null; // { id, fetchedAt }

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

// Match an entry header. Two formats observed in the wild:
//   OLD: [66.***Primate -R***  - Paramount - January 05 2026](https://www.amctheatres.com/movies/amc-scream-unseen-january-5-82402)
//        -- title is inline; bullets below have ARR/AR runtimes.
//   NEW: [81.***Rated R***  - 2h22m - May 4 2026](https://www.amctheatres.com/movies/amc-screen-unseen-may-4-83506)
//        -- title is NOT inline; a "- Revealed As: >!Movie Title!<" line appears 1-3 lines below.
//
// Group 1: number. Group 2: inner content (either "Title -Rating" or "Rated R").
// Group 3: optional middle field (studio, or runtime in new format).
// Group 4: date. Group 5: full URL. Group 6: 'screen' | 'scream' (from URL slug).
const HEADER_RE = new RegExp(
  '\\[(\\d+)\\.\\*{3}([^*]+?)\\*{3}\\s*' +
    '(?:-\\s*([^\\-\\n]+?)\\s*)?-\\s*' +
    '([A-Z][a-z]+\\s+\\d{1,2}(?:\\s*&\\s*\\d{1,2})?\\s+\\d{4})' +
    '\\]\\((https:\\/\\/www\\.amctheatres\\.com\\/movies\\/amc-(screen|scream)-unseen-[^)]+)\\)',
  'gi'
);

// "- Revealed As: >!Title!<" — possibly with HTML-encoded entities even when raw_json=1
const REVEAL_RE = /Revealed\s+As\s*:\s*(?:&gt;|>)!\s*(.+?)\s*!(?:&lt;|<)/i;

// Predecessor links — Reddit share-link form, one per range.
const PREDECESSOR_RE =
  /\[ASU's[^\]]+\]\((https?:\/\/(?:www\.)?reddit\.com\/[^)]+)\)/gi;

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': REDDIT_UA, Accept: 'application/json' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Reddit ${res.status} ${res.statusText} for ${url}`);
  }
  return { json: await res.json(), finalUrl: res.url };
}

function parseDateString(s) {
  // "January 05 2026" or "May 3 & 4 2026"
  const m = /^([A-Z][a-z]+)\s+(\d{1,2})(?:\s*&\s*(\d{1,2}))?\s+(\d{4})$/i.exec(s.trim());
  if (!m) return [];
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return [];
  const year = parseInt(m[4], 10);
  const d1 = parseInt(m[2], 10);
  const fmt = (d) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dates = [fmt(d1)];
  if (m[3]) dates.push(fmt(parseInt(m[3], 10)));
  return dates;
}

function parseMegathread(selftext) {
  const entries = [];
  if (!selftext) return entries;
  // Decode common HTML entities in case Reddit didn't honour raw_json=1.
  const text = selftext
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');

  const matches = [...text.matchAll(HEADER_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const number = parseInt(m[1], 10);
    const inner = m[2].trim();
    const middle = m[3] ? m[3].trim() : '';
    const dateStr = m[4];
    const url = m[5];
    const type = m[6].toLowerCase();

    // Inner content can be either "<Title> -<Rating>" (old) or "Rated <Rating>" (new).
    let title = null;
    let rating = null;
    const inlineTitle = /^(.+?)\s+-(R|PG-13|PG|G|NC-17|NR|Unrated)$/i.exec(inner);
    if (inlineTitle) {
      title = inlineTitle[1].trim();
      rating = inlineTitle[2];
    } else {
      const ratedOnly = /^Rated\s+(R|PG-13|PG|G|NC-17|NR|Unrated)$/i.exec(inner);
      if (ratedOnly) rating = ratedOnly[1];
    }

    // For new-format placeholders, look for "Revealed As: >!Title!<" in the body
    // between this entry header and the next one (or end-of-text, capped to 500 chars).
    if (!title) {
      const start = m.index + m[0].length;
      const end =
        i + 1 < matches.length
          ? matches[i + 1].index
          : Math.min(text.length, start + 500);
      const slice = text.slice(start, end);
      const reveal = REVEAL_RE.exec(slice);
      if (reveal && !/^TBD$/i.test(reveal[1])) {
        title = reveal[1].trim();
      }
    }

    if (!title) continue; // Unrevealed (e.g. ">!TBD!<" or no spoiler line) — skip.

    // Old format: middle = studio. New format: middle = runtime like "1h55m".
    const studio = middle && !/^\d+\s*h(?:\s*\d+\s*m)?$/i.test(middle) ? middle : null;

    const dates = parseDateString(dateStr);
    for (const date of dates) {
      entries.push({ number, title, rating, studio, date, url, type });
    }
  }
  return entries;
}

function extractPredecessorUrls(selftext) {
  if (!selftext) return [];
  const out = [];
  for (const m of selftext.matchAll(PREDECESSOR_RE)) {
    out.push(m[1]);
  }
  return out;
}

// Resolve a Reddit share link (or any reddit URL) to a post ID by following redirects.
async function resolveToPostId(url) {
  // Already a /comments/<id>/ form?
  let m = /\/comments\/([a-z0-9]+)/i.exec(url);
  if (m) return m[1];
  // Otherwise follow the redirect (share links use /s/<token>).
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': REDDIT_UA },
      redirect: 'follow',
    });
    m = /\/comments\/([a-z0-9]+)/i.exec(res.url);
    return m ? m[1] : null;
  } catch (err) {
    logger.error('resolveToPostId failed:', url, err.message);
    return null;
  }
}

async function loadThread(postId) {
  const cached = threadCache.get(postId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;
  const { json } = await fetchJson(
    `https://www.reddit.com/comments/${postId}.json?raw_json=1`
  );
  const post = json[0]?.data?.children?.[0]?.data;
  if (!post) throw new Error(`malformed Reddit response for ${postId}`);
  const selftext = post.selftext || '';
  const result = {
    entries: parseMegathread(selftext),
    predecessorUrls: extractPredecessorUrls(selftext),
    fetchedAt: Date.now(),
    title: post.title,
  };
  threadCache.set(postId, result);
  logger.info(
    `unseen-lookup: cached megathread ${postId} ("${post.title}") — ${result.entries.length} entries, ${result.predecessorUrls.length} predecessor links`
  );
  return result;
}

async function findCurrentMegathreadId() {
  if (
    currentMegathreadCache &&
    Date.now() - currentMegathreadCache.fetchedAt < CACHE_TTL_MS
  ) {
    return currentMegathreadCache.id;
  }
  const { json } = await fetchJson(SEARCH_URL);
  const children = json?.data?.children || [];
  for (const c of children) {
    const t = c?.data?.title || '';
    if (/megathread/i.test(t) && /screen\s+unseen/i.test(t)) {
      currentMegathreadCache = { id: c.data.id, fetchedAt: Date.now() };
      return c.data.id;
    }
  }
  return null;
}

// Walk current megathread, then its predecessors, until we find an entry matching date+type
// (or run out of threads).
async function lookupByDate(date, type) {
  const targetType = (type || '').toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const startId = await findCurrentMegathreadId();
  if (!startId) {
    logger.error('unseen-lookup: could not find current megathread');
    return null;
  }

  const visited = new Set();
  const queue = [startId];
  while (queue.length) {
    const id = queue.shift();
    if (visited.has(id)) continue;
    visited.add(id);

    let thread;
    try {
      thread = await loadThread(id);
    } catch (err) {
      logger.error(`unseen-lookup: load ${id} failed: ${err.message}`);
      continue;
    }

    const hit = thread.entries.find(
      (e) => e.date === date && (!targetType || e.type === targetType)
    );
    if (hit) return hit;

    // Queue predecessors for backwards walk.
    for (const url of thread.predecessorUrls) {
      const pid = await resolveToPostId(url);
      if (pid && !visited.has(pid)) queue.push(pid);
    }
  }
  return null;
}

// Resolve a watch's actual movie via Reddit + TMDB, update DB. Returns:
//   { resolved: true, tmdbId, title }   on success
//   { resolved: false, reason: '...' }  otherwise (idempotent — does not touch DB)
async function resolveAndAssign(watchId, opts = {}) {
  const { force = false } = opts;
  const r = await pool.query(
    `SELECT id, title, showtime, watched_at, tmdb_id FROM watches WHERE id = $1`,
    [watchId]
  );
  if (!r.rows.length) return { resolved: false, reason: 'watch not found' };
  const w = r.rows[0];

  if (!force && w.tmdb_id) return { resolved: false, reason: 'already enriched' };

  const m = /AMC\s+(Screen|Scream)\s+Unseen/i.exec(w.title || '');
  if (!m) return { resolved: false, reason: 'not an AMC Screen/Scream Unseen' };
  const type = m[1].toLowerCase();

  const showDate = w.showtime || w.watched_at;
  if (!showDate) return { resolved: false, reason: 'no date' };
  const isoDate = new Date(showDate).toISOString().slice(0, 10);

  const entry = await lookupByDate(isoDate, type);
  if (!entry) {
    logger.info(
      `unseen-lookup: no megathread entry for ${isoDate} (${type}) — watch ${watchId}`
    );
    return { resolved: false, reason: 'no megathread entry' };
  }

  logger.info(
    `unseen-lookup: ${isoDate} (${type}) → "${entry.title}" (#${entry.number}, ${entry.studio})`
  );

  let tmdbId = null;
  let needsReview = true;
  try {
    const match = await tmdb.autoMatch(entry.title);
    if (match) {
      tmdbId = match.tmdb_id;
      needsReview = match.needs_review;
    }
  } catch (err) {
    logger.error({ err: err }, 'unseen-lookup TMDB enrichment failed');
  }

  await pool.query(
    `UPDATE watches
     SET tmdb_id = $1,
         tmdb_needs_review = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [tmdbId, needsReview, watchId]
  );

  return { resolved: true, tmdbId, title: entry.title, entryNumber: entry.number };
}

// Clear in-memory caches. Called from the manual "Re-check Reddit" path so a
// click immediately re-fetches the megathread instead of serving 12h-stale data.
function clearCaches() {
  threadCache.clear();
  currentMegathreadCache = null;
}

module.exports = {
  resolveAndAssign,
  lookupByDate,
  parseMegathread,
  parseDateString,
  clearCaches,
  // exported for tests/scripts
  _internal: { loadThread, findCurrentMegathreadId, threadCache },
};
