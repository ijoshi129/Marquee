// Resolve actual movie titles for AMC Screen/Scream Unseen watches by parsing
// r/AMCsAList megathreads. The current sticky megathread lists recent reveals;
// older megathreads cover ranges (1-22, 21-32, ...) and are linked from the body.
//
// Reddit now 403s its unauthenticated JSON API, so we read the rendered HTML
// from old.reddit.com (still public) and parse it with cheerio. One fetch per
// ~12h per megathread — negligible traffic.

const cheerio = require('cheerio');
const { pool } = require('../db');
const logger = require('../logger');
const tmdb = require('./tmdb');
const trakt = require('./trakt');

const REDDIT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const SEARCH_URL =
  'https://old.reddit.com/r/AMCsAList/search?q=screen%20unseen%20megathread&restrict_sr=1&sort=new&t=year';

const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const LOOKUP_TIME_ZONE = process.env.APP_TIMEZONE || process.env.TZ || 'America/New_York';
// postId → { entries, predecessorUrls, fetchedAt }
const threadCache = new Map();
let currentMegathreadCache = null; // { id, fetchedAt }

const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
};

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

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': REDDIT_UA, Accept: 'text/html' },
    redirect: 'follow',
  });
  if (!res.ok) {
    throw new Error(`Reddit ${res.status} ${res.statusText} for ${url}`);
  }
  return { $: cheerio.load(await res.text()), finalUrl: res.url };
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
  const { $ } = await fetchHtml(`https://old.reddit.com/comments/${postId}/`);
  const md = $('#siteTable .usertext-body .md').first();
  if (!md.length) throw new Error(`no post body for ${postId}`);
  const title = $('#siteTable a.title').first().text().trim();
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

async function findCurrentMegathreadId() {
  if (
    currentMegathreadCache &&
    Date.now() - currentMegathreadCache.fetchedAt < CACHE_TTL_MS
  ) {
    return currentMegathreadCache.id;
  }
  const { $ } = await fetchHtml(SEARCH_URL);
  let id = null;
  $('a.search-title').each((i, el) => {
    if (id) return;
    const t = $(el).text();
    const href = $(el).attr('href') || '';
    if (/megathread/i.test(t) && /screen\s*unseen/i.test(t)) {
      const m = /\/comments\/([a-z0-9]+)/i.exec(href);
      if (m) id = m[1];
    }
  });
  if (id) currentMegathreadCache = { id, fetchedAt: Date.now() };
  return id;
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
    threadCache,
    formatDateInTimeZone,
    lookupDatesForWatch,
  },
};
