const assert = require('node:assert/strict');
const cheerio = require('cheerio');
const { test } = require('./harness');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const {
  parseMegathread,
  parseDateString,
  _internal: { parseFeedEntries },
} = require('../services/unseen-lookup');

// Shaped like a post's `selftext_html` from the Reddit API — the same rendered
// markup old.reddit.com used to serve, which is why the parser survived the
// move off scraping.
const MEGATHREAD_HTML = `<div class="md"><ul>
<li><p><a href="https://www.amctheatres.com/movies/amc-screen-unseen-january-05-2026-79999">66.Primate -R  - Paramount - January 05 2026</a></p></li>
<li><p><a href="https://www.amctheatres.com/movies/amc-screen-unseen-june-01-2026-80112">83.Rated R  - 1h57m - June 1 2026</a></p>
<ul><li>Revealed As: <span class="md-spoiler-text">The Long Walk</span></li></ul></li>
<li><p><a href="https://www.amctheatres.com/movies/amc-scream-unseen-october-13-2026-80999">12.Rated R - 1h40m - October 13 2026</a></p>
<ul><li>Revealed As: <span class="md-spoiler-text">TBD</span></li></ul></li>
</ul></div>`;

function parse(html) {
  const $ = cheerio.load(html);
  return parseMegathread($, $('.md').first());
}

test('parseMegathread reads inline titles, spoilered reveals, and screen/scream type', () => {
  const entries = parse(MEGATHREAD_HTML);
  // The TBD entry is unrevealed and must not produce a row.
  assert.equal(entries.length, 2);

  assert.deepEqual(
    { title: entries[0].title, date: entries[0].date, type: entries[0].type },
    { title: 'Primate', date: '2026-01-05', type: 'screen' }
  );
  assert.equal(entries[0].studio, 'Paramount');

  assert.deepEqual(
    { title: entries[1].title, date: entries[1].date, type: entries[1].type },
    { title: 'The Long Walk', date: '2026-06-01', type: 'screen' }
  );
  // A runtime in the middle field is not a studio.
  assert.equal(entries[1].studio, null);
});

test('parseMegathread returns nothing for an empty body', () => {
  assert.deepEqual(parse('<div class="md"></div>'), []);
});

// A post feed returns the post first, then its comments. Only the post carries
// the megathread body, and its link is one path segment shorter.
const POST_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>AMC Screen Unseen Megathread - August 10 2026</title>
    <link href="https://www.reddit.com/r/AMCsAList/comments/1vfy14u/amc_screen_unseen_megathread_august_10_2026/" />
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;body&lt;/p&gt;&lt;/div&gt;</content>
  </entry>
  <entry>
    <title>comment by someone</title>
    <link href="https://www.reddit.com/r/AMCsAList/comments/1vfy14u/amc_screen_unseen_megathread_august_10_2026/p31rf89/" />
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;my guess is Tron&lt;/p&gt;&lt;/div&gt;</content>
  </entry>
</feed>`;

test('parseFeedEntries unescapes post bodies and tells posts from comments', () => {
  const entries = parseFeedEntries(POST_FEED);
  assert.equal(entries.length, 2);

  assert.equal(entries[0].isPost, true);
  assert.equal(entries[0].postId, '1vfy14u');
  assert.equal(entries[0].title, 'AMC Screen Unseen Megathread - August 10 2026');
  assert.equal(entries[0].bodyHtml, '<div class="md"><p>body</p></div>');

  assert.equal(entries[1].isPost, false);
});

test('parseFeedEntries ignores entries that are not post links', () => {
  const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><title>t</title><link href="https://www.reddit.com/r/AMCsAList/" /></entry>
</feed>`;
  assert.deepEqual(parseFeedEntries(feed), []);
});

test('parseDateString handles single and two-day screenings', () => {
  assert.deepEqual(parseDateString('January 05 2026'), ['2026-01-05']);
  assert.deepEqual(parseDateString('May 3 & 4 2026'), ['2026-05-03', '2026-05-04']);
  assert.deepEqual(parseDateString('not a date'), []);
});

// The megathread mixes both forms in one list — full names through July 2026,
// abbreviations from August on.
test('parseDateString accepts abbreviated month names', () => {
  assert.deepEqual(parseDateString('Aug 10 2026'), ['2026-08-10']);
  assert.deepEqual(parseDateString('Sept 7 2026'), ['2026-09-07']);
  assert.deepEqual(parseDateString('Dec 25 2026'), ['2026-12-25']);
  assert.deepEqual(parseDateString('Foo 10 2026'), []);
});

// Megathread discovery. Reddit lets logged-out readers through about once a
// minute and has closed feeds outright before, so discovery has three sources.
const { pool } = require('../db');
const unseenLookup = require('../services/unseen-lookup');
const { afterEach } = require('./harness');

const OTHER_POST = `<entry>
    <title>Weekly discussion</title>
    <link href="https://www.reddit.com/r/AMCsAList/comments/1aaaaaa/weekly_discussion/" />
    <content type="html">&lt;div class="md"&gt;&lt;p&gt;hi&lt;/p&gt;&lt;/div&gt;</content>
  </entry>`;

// A listing or search feed by default; `{ alone: true }` gives the thread's own
// feed, which holds just the post.
const megathreadFeed = (id, { alone = false } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  ${alone ? '' : OTHER_POST}
  <entry>
    <title>AMC Screen Unseen Megathread - November 9 2026</title>
    <link href="https://www.reddit.com/r/AMCsAList/comments/${id}/amc_screen_unseen_megathread_november_9_2026/" />
    <content type="html">${MEGATHREAD_HTML.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</content>
  </entry>
</feed>`;

unseenLookup._internal.setFetchGapMs(0);

const realFetch = global.fetch;
const realQuery = pool.query;
afterEach(() => {
  global.fetch = realFetch;
  pool.query = realQuery;
  unseenLookup.clearCaches();
});

function stubReddit(respond) {
  const urls = [];
  global.fetch = async (url) => {
    urls.push(url);
    const r = respond(url);
    return typeof r === 'string'
      ? { ok: true, status: 200, text: async () => r }
      : { ok: false, status: r, statusText: 'Forbidden' };
  };
  return urls;
}

function stubState(initial) {
  const state = { value: initial, writes: 0 };
  pool.query = async (sql, params) => {
    if (!/app_state/.test(sql)) throw new Error(`unexpected query: ${sql}`);
    // app_state also holds each job's run record; only the megathread id matters here.
    if (params[0] !== 'unseen_megathread_id') return { rows: [] };
    if (/^\s*INSERT/.test(sql)) {
      state.value = params[1];
      state.writes += 1;
      return { rows: [] };
    }
    return { rows: state.value ? [{ value: state.value }] : [] };
  };
  return state;
}

test('megathread discovery reads the pinned post off the subreddit listing', async () => {
  const urls = stubReddit(() => megathreadFeed('1xpdvmb'));
  const state = stubState(null);

  const id = await unseenLookup._internal.findCurrentMegathreadId();

  assert.equal(id, '1xpdvmb');
  assert.equal(urls.length, 1);
  assert.match(urls[0], /\/hot\.rss/);
  assert.equal(state.value, '1xpdvmb');
  // The body came with the listing, so the thread needs no request of its own.
  const hit = await unseenLookup.lookupByDate('2026-06-01', 'screen');
  assert.equal(hit.title, 'The Long Walk');
  assert.equal(urls.length, 1);
  assert.equal(state.writes, 1);
});

test('megathread discovery falls back to search when the listing has no megathread', async () => {
  const urls = stubReddit((url) =>
    /search\.rss/.test(url) ? megathreadFeed('1search') : megathreadFeed('1other').replace(/Megathread/g, 'chat')
  );
  stubState(null);

  assert.equal(await unseenLookup._internal.findCurrentMegathreadId(), '1search');
  assert.equal(urls.length, 2);
});

test('megathread discovery reuses the last known thread when Reddit refuses both feeds', async () => {
  const urls = stubReddit((url) => (/comments\/1xold/.test(url) ? megathreadFeed('1xold', { alone: true }) : 403));
  const state = stubState('1xold');

  assert.equal(await unseenLookup._internal.findCurrentMegathreadId(), '1xold');
  assert.equal(state.writes, 0);

  const hit = await unseenLookup.lookupByDate('2026-06-01', 'screen');
  assert.equal(hit.title, 'The Long Walk');
  assert.match(urls[urls.length - 1], /comments\/1xold\.rss/);
});

test('megathread discovery reports nothing when Reddit is closed and no thread is remembered', async () => {
  stubReddit(() => 403);
  stubState(null);
  assert.equal(await unseenLookup._internal.findCurrentMegathreadId(), null);
});
