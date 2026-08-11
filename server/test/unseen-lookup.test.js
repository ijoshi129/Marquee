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
