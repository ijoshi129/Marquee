// Resolve actual movie titles for AMC Screen/Scream Unseen watches by parsing
// r/AMCsAList megathreads. The current sticky megathread lists recent reveals;
// older megathreads cover ranges (1-22, 21-32, ...) and are linked from the body.
//
// Reddit gates logged-out HTML (old.reddit.com redirects to /login) and 403s
// its JSON API, but still serves Atom feeds to readers — and a feed entry's
// <content> is the same rendered post body the old scraper read off the page,
// so the parsing below is unchanged. One fetch per ~12h per megathread —
// negligible traffic, no account or API key involved.

const cheerio = require('cheerio');
const { pool } = require('../db');
const logger = require('../logger');
const tmdb = require('./tmdb');
const trakt = require('./trakt');

const FEED_UA = 'marquee/1.0 (self-hosted AMC tracker; +https://github.com/ijoshi129/marquee)';
const SUBREDDIT = 'AMCsAList';
const SEARCH_FEED_URL =
  `https://www.reddit.com/r/${SUBREDDIT}/search.rss` +
  '?q=screen+unseen+megathread&restrict_sr=1&sort=new&t=year';
const postFeedUrl = (postId) =>
  `https://www.reddit.com/r/${SUBREDDIT}/comments/${postId}.rss?limit=1`;

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const FETCH_GAP_MS = 3000;
const THROTTLED_BACKOFF_MS = 20000;
const FETCH_ATTEMPTS = 3;
const LOOKUP_TIME_ZONE = process.env.APP_TIMEZONE || process.env.TZ || 'America/New_York';
// postId → { entries, predecessorUrls, fetchedAt }
const threadCache = new Map();
let currentMegathreadCache = null; // { id, fetchedAt }

// Keyed on the first three letters: the megathread mixes full month names with
// abbreviations ("July 27 2026" and "Aug 10 2026" sit in the same list), and
// September shows up as both "Sep" and "Sept".
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

const monthIndex = (name) => MONTHS[String(name).slice(0, 3).toLowerCase()];

// Each entry is an AMC link in the post body. Two formats observed:
//   OLD: "66.Primate -R  - Paramount - January 05 2026"  → title inline
//   NEW: "83.Rated R  - 1h57m - June 1 2026"             → title NOT inline;
//        a "- Revealed As: >!Movie Title!<" bullet follows below.
// The link's href slug carries the screen|scream type and the date.

// "Revealed As: >!Title!<" (spoilers re-inlined from <span class="md-spoiler-text">).
const REVEAL_RE = /Revealed\s+As\s*:\s*>!\s*(.+?)\s*!</i;

// Pull the entry number, optional inline title, rating, optional middle field
// (studio or runtime), and the date off a link's rendered text.
const ENTRY_TEXT_RE =
  /^(\d+)\.(.+?)\s*-\s*([A-Z][a-z]+\s+\d{1,2}(?:\s*&\s*\d{1,2})?\s+\d{4})\s*$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reddit 429s a burst of feed requests, which the walk back through predecessor
// megathreads would otherwise trigger. Space them out, and back off further
// when throttled anyway before giving up on that thread.
let lastFetchAt = 0;
async function fetchFeed(url) {
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt++) {
    const gap = FETCH_GAP_MS - (Date.now() - lastFetchAt);
    if (gap > 0) await sleep(gap);
    lastFetchAt = Date.now();

    const res = await fetch(url, {
      headers: { 'User-Agent': FEED_UA, Accept: 'application/atom+xml' },
      redirect: 'follow',
    });
    if (res.ok) return res.text();
    if (res.status !== 429 || attempt === FETCH_ATTEMPTS - 1) {
      throw new Error(`Reddit ${res.status} ${res.statusText} for ${url}`);
    }
    await sleep(THROTTLED_BACKOFF_MS * (attempt + 1));
  }
}

// Atom entries carry the post id in their link and the rendered body in
// <content type="html">. Comment entries link one path segment deeper than the
// post itself, which is how the post is told apart from replies to it.
function parseFeedEntries(xml) {
  const $ = cheerio.load(xml, { xmlMode: true });
  const out = [];
  $('entry').each((i, el) => {
    const entry = $(el);
    const link = entry.find('link').first().attr('href') || '';
    const m = /\/comments\/([a-z0-9]+)\/([^/?#]*)\/?([^?#]*)/i.exec(link);
    if (!m) return;
    out.push({
      postId: m[1],
      isPost: !m[3],
      title: entry.find('title').first().text().trim(),
      bodyHtml: entry.find('content').first().text(),
    });
  });
  return out;
}

function parseDateString(s) {
  // "January 05 2026", "Aug 10 2026", or "May 3 & 4 2026"
  const m = /^([A-Z][a-z]+)\s+(\d{1,2})(?:\s*&\s*(\d{1,2}))?\s+(\d{4})$/i.exec(s.trim());
  if (!m) return [];
  const month = monthIndex(m[1]);
  if (month === undefined) return [];
  const year = parseInt(m[4], 10);
  const d1 = parseInt(m[2], 10);
  const fmt = (d) =>
    `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const dates = [fmt(d1)];
  if (m[3]) dates.push(fmt(parseInt(m[3], 10)));
  return dates;
}

function formatDateInTimeZone(value, timeZone = LOOKUP_TIME_ZONE) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    const year = get('year');
    const month = get('month');
    const day = get('day');
    return year && month && day ? `${year}-${month}-${day}` : null;
  } catch (err) {
    logger.error({ err }, `unseen-lookup: invalid timezone ${timeZone}`);
    return date.toISOString().slice(0, 10);
  }
}

function addDaysToIsoDate(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function lookupDatesForWatch(w) {
  const dates = [];
  const push = (date) => {
    if (date && !dates.includes(date)) dates.push(date);
  };

  if (w.showtime) {
    push(formatDateInTimeZone(w.showtime));
    push(new Date(w.showtime).toISOString().slice(0, 10));
  } else if (w.watched_at) {
    const localDate = formatDateInTimeZone(w.watched_at);
    push(localDate);
    push(addDaysToIsoDate(localDate, -1));
    push(new Date(w.watched_at).toISOString().slice(0, 10));
  }

  return dates;
}

// Parse the megathread body (a cheerio-wrapped `.md` element). Each Screen/
// Scream Unseen is an <a> to amctheatres.com; the reveal for new-format entries
// is a "Revealed As: >!Title!<" bullet between this link and the next.
function parseMegathread($, md) {
  const entries = [];
  if (!md || !md.length) return entries;

  // Re-inline spoiler spans as >!…!< so REVEAL_RE works on the flat text.
  md.find('span.md-spoiler-text').each((i, el) => {
    $(el).replaceWith(`>!${$(el).text()}!<`);
  });
  // Collapse whitespace so the normalized link text below locates cleanly.
  const fullText = md.text().replace(/\s+/g, ' ');

  const anchors = md.find('a[href*="amctheatres.com/movies/amc-"]').toArray();
  for (let i = 0; i < anchors.length; i++) {
    const a = anchors[i];
    const linkText = $(a).text().trim().replace(/\s+/g, ' ');
    const href = $(a).attr('href') || '';
    const slug = /amc-(screen|scream)-unseen-[^/?#]+/i.exec(href);
    const type = slug ? slug[1].toLowerCase() : 'screen';

    const em = ENTRY_TEXT_RE.exec(linkText);
    if (!em) continue;
    const number = parseInt(em[1], 10);
    const dateStr = em[3];
    let body = em[2].trim(); // "Primate -R - Paramount" | "Rated R - 1h57m"

    let title = null;
    let rating = null;
    let studio = null;
    const inline = /^(.+?)\s*-\s*(R|PG-13|PG|G|NC-17|NR|Unrated)\b\s*(?:-\s*(.+))?$/i.exec(body);
    if (inline) {
      title = inline[1].trim();
      rating = inline[2];
      const middle = (inline[3] || '').trim();
      studio = middle && !/^\d+\s*h(?:\s*\d+\s*m)?$/i.test(middle) ? middle : null;
    } else {
      const rated = /^Rated\s+(R|PG-13|PG|G|NC-17|NR|Unrated)\b/i.exec(body);
      if (rated) rating = rated[1];
    }

    // New-format: title comes from a "Revealed As: >!…!<" bullet below, up to
    // the next entry link (or +500 chars).
    if (!title) {
      const start = fullText.indexOf(linkText);
      const from = start >= 0 ? start + linkText.length : 0;
      const nextText = i + 1 < anchors.length ? $(anchors[i + 1]).text().trim().replace(/\s+/g, ' ') : null;
      const nextIdx = nextText ? fullText.indexOf(nextText, from) : -1;
      const end = nextIdx >= 0 ? nextIdx : Math.min(fullText.length, from + 500);
      const reveal = REVEAL_RE.exec(fullText.slice(from, end));
      if (reveal && !/^TBD$/i.test(reveal[1])) title = reveal[1].trim();
    }

    if (!title) continue; // Unrevealed (TBD / no reveal yet) — skip.

    for (const date of parseDateString(dateStr)) {
      entries.push({ number, title, rating, studio, date, url: href, type });
    }
  }
  return entries;
}

// Predecessor megathreads are "ASU's N-M" links to reddit (cover earlier ranges).
function extractPredecessorUrls($, md) {
  if (!md || !md.length) return [];
  const out = [];
  md.find('a').each((i, el) => {
    const t = $(el).text().trim();
    const h = $(el).attr('href') || '';
    if (/^ASU's\s+\d+\s*-\s*\d+/i.test(t) && /reddit\.com/.test(h)) out.push(h);
  });
  return out;
}

// Resolve a Reddit link to a post ID. Predecessor megathreads are linked as
// share URLs (/s/<token>) that carry no id, so those need the redirect chased.
async function resolveToPostId(url) {
  let m = /\/comments\/([a-z0-9]+)/i.exec(url);
  if (m) return m[1];
  try {
    const res = await fetch(url, { headers: { 'User-Agent': FEED_UA }, redirect: 'follow' });
    m = /\/comments\/([a-z0-9]+)/i.exec(res.url);
    return m ? m[1] : null;
  } catch (err) {
    logger.error(`unseen-lookup: could not resolve ${url}: ${err.message}`);
    return null;
  }
}

function cacheThread(postId, title, bodyHtml) {
  const $ = cheerio.load(bodyHtml);
  const md = $('.md').first();
  if (!md.length) throw new Error(`no post body for ${postId}`);
  const result = {
    entries: parseMegathread($, md),
    predecessorUrls: extractPredecessorUrls($, md),
    fetchedAt: Date.now(),
    title,
  };
  threadCache.set(postId, result);
  logger.info(
    `unseen-lookup: cached megathread ${postId} ("${title}") — ${result.entries.length} entries, ${result.predecessorUrls.length} predecessor links`
  );
  return result;
}

async function loadThread(postId) {
  const cached = threadCache.get(postId);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached;

  // limit=1 because only the post body matters — the comment tree is dead weight.
  const entries = parseFeedEntries(await fetchFeed(postFeedUrl(postId)));
  const post = entries.find((e) => e.isPost && e.bodyHtml);
  if (!post) throw new Error(`no post body for ${postId}`);
  return cacheThread(postId, post.title, post.bodyHtml);
}

async function findCurrentMegathreadId() {
  if (
    currentMegathreadCache &&
    Date.now() - currentMegathreadCache.fetchedAt < CACHE_TTL_MS
  ) {
    return currentMegathreadCache.id;
  }
  let entries;
  try {
    entries = parseFeedEntries(await fetchFeed(SEARCH_FEED_URL));
  } catch (err) {
    logger.error(`unseen-lookup: megathread search failed: ${err.message}`);
    return null;
  }

  // Screen and Scream megathreads carry the same shared history list, so the
  // newest of either is the freshest source.
  const hit = entries.find(
    (e) => /megathread/i.test(e.title) && /(screen|scream)\s*unseen/i.test(e.title)
  );
  if (!hit) return null;

  // The search feed already includes the body, so there's no reason to fetch
  // the thread again on the way back out.
  if (hit.bodyHtml && !threadCache.has(hit.postId)) {
    try {
      cacheThread(hit.postId, hit.title, hit.bodyHtml);
    } catch (err) {
      logger.error(`unseen-lookup: search feed body unusable: ${err.message}`);
    }
  }

  currentMegathreadCache = { id: hit.postId, fetchedAt: Date.now() };
  return hit.postId;
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

    // Predecessors only cover earlier ranges, so a date at or after this
    // thread's oldest entry is already inside the range we just searched —
    // it simply hasn't been revealed yet. Walking back would be five more
    // requests for a guaranteed miss, every retry, for every fresh Unseen.
    const oldest = thread.entries.reduce(
      (min, e) => (min === null || e.date < min ? e.date : min),
      null
    );
    if (oldest && date >= oldest) continue;

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
    `SELECT id, title, showtime, watched_at, tmdb_id, trakt_sync_requested_at
     FROM watches
     WHERE id = $1`,
    [watchId]
  );
  if (!r.rows.length) return { resolved: false, reason: 'watch not found' };
  const w = r.rows[0];

  if (!force && w.tmdb_id) return { resolved: false, reason: 'already enriched' };

  const m = /AMC\s+(Screen|Scream)\s+Unseen/i.exec(w.title || '');
  if (!m) return { resolved: false, reason: 'not an AMC Screen/Scream Unseen' };
  const type = m[1].toLowerCase();

  const lookupDates = lookupDatesForWatch(w);
  if (!lookupDates.length) return { resolved: false, reason: 'no date' };

  let entry = null;
  let isoDate = null;
  for (const date of lookupDates) {
    entry = await lookupByDate(date, type);
    if (entry) {
      isoDate = date;
      break;
    }
  }
  if (!entry) {
    logger.info(
      `unseen-lookup: no megathread entry for ${lookupDates.join(', ')} (${type}) — watch ${watchId}`
    );
    return { resolved: false, reason: 'no megathread entry' };
  }

  logger.info(
    `unseen-lookup: ${isoDate} (${type}) → "${entry.title}" (#${entry.number}, ${entry.studio})`
  );

  let tmdbId = null;
  let needsReview = true;
  try {
    const match = await tmdb.autoMatch(entry.title, {
      year: tmdb.yearOf(w.showtime || w.watched_at),
    });
    if (match) {
      tmdbId = match.tmdb_id;
      needsReview = !!match.needs_review;
    }
  } catch (err) {
    logger.error({ err: err }, 'unseen-lookup TMDB enrichment failed');
  }

  // We found the megathread entry but couldn't pin it to a TMDB id (no match or
  // a transient TMDB error). Report not-resolved so the rechecker burns a normal
  // retry and eventually abandons, and never write a NULL over an existing id.
  if (!tmdbId) {
    return { resolved: false, reason: 'no TMDB match for revealed title' };
  }

  await pool.query(
    `UPDATE watches
     SET tmdb_id = $1,
         tmdb_needs_review = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [tmdbId, needsReview, watchId]
  );

  if (tmdbId && w.trakt_sync_requested_at) {
    trakt.queueWatch(watchId).catch((err) => {
      logger.error({ err, watch_id: watchId }, 'trakt queue failed (non-fatal)');
    });
  }

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
  _internal: {
    loadThread,
    findCurrentMegathreadId,
    parseFeedEntries,
    threadCache,
    formatDateInTimeZone,
    lookupDatesForWatch,
  },
};
