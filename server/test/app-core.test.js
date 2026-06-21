const assert = require('node:assert/strict');
const { test } = require('./harness');

const { classify } = require('../services/email-classify');
const {
  cleanTitle,
  displayTitle,
  extractFormatsFromHtml,
  extractTags,
  normalizeText,
} = require('../utils/normalize');
// rankResults is pure, but tmdb.js pulls in db.js, which validates a connection
// string at load — give it a throwaway one (no query is ever run).
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const { rankResults } = require('../services/tmdb');
const reservation = require('../parsers/amc-reservation');
const thankyou = require('../parsers/amc-thankyou');
const cancellation = require('../parsers/amc-cancellation');
const { clean, parseDateThen24Hr, parseTimeThenDate } = require('../parsers/util');
const { computeAlistValue } = require('../services/alist-value');

test('normalizeText removes accents, punctuation, and duplicate spacing', () => {
  assert.equal(normalizeText('  Amelie:  L`ete!!  '), 'amelie l ete');
});

test('cleanTitle strips stacked AMC format and caption suffixes', () => {
  assert.equal(
    cleanTitle('Avatar: Fire and Ash in RealD 3D Open Caption'),
    'Avatar: Fire and Ash'
  );
  assert.equal(cleanTitle('Dune: Part Two IMAX 70mm'), 'Dune: Part Two');
});

test('cleanTitle strips anniversary and re-release decorations', () => {
  assert.equal(cleanTitle('Top Gun 40th Anniversary'), 'Top Gun');
  assert.equal(cleanTitle('The Goonies 40th Anniversary Re-Release'), 'The Goonies');
  assert.equal(cleanTitle('Spirited Away: 20th Anniversary'), 'Spirited Away');
  assert.equal(cleanTitle('Top Gun 40th Anniversary in RealD 3D'), 'Top Gun');
  // No "Nth" prefix — a real title that merely contains "Anniversary" is kept.
  assert.equal(cleanTitle('Happy Anniversary'), 'Happy Anniversary');
});

test('rankResults biases toward the watch year, excludes the far future, skips re-releases', () => {
  const deepWater = [
    { tmdb_id: 1, title: 'Deep Water', release_year: 2022, popularity: 50 },
    { tmdb_id: 2, title: 'Deep Water', release_year: 2026, popularity: 5 },
  ];
  // Seen in 2026: the 2026 release wins despite the 2022 film being more popular.
  assert.equal(rankResults(deepWater, { year: 2026 })[0].tmdb_id, 2);
  // No year context: falls back to popularity.
  assert.equal(rankResults(deepWater, {})[0].tmdb_id, 1);

  // A far-future release can't be the one screened.
  const future = [
    { tmdb_id: 1, title: 'X', release_year: 2030, popularity: 100 },
    { tmdb_id: 2, title: 'X', release_year: 2024, popularity: 1 },
  ];
  assert.equal(rankResults(future, { year: 2026 })[0].tmdb_id, 2);

  // Re-release: year bias is skipped, so popularity decides.
  const rerelease = [
    { tmdb_id: 1, title: 'Top Gun', release_year: 1986, popularity: 10 },
    { tmdb_id: 2, title: 'Top Gun: Maverick', release_year: 2022, popularity: 100 },
  ];
  assert.equal(rankResults(rerelease, { year: 2026, rerelease: true })[0].tmdb_id, 2);
});

test('displayTitle keeps the watch title for re-releases, TMDB name otherwise', () => {
  // Re-release: keep what the user saw, not the flattened TMDB name.
  assert.equal(displayTitle('Top Gun 40th Anniversary', 'Top Gun'), 'Top Gun 40th Anniversary');
  // Ordinary film: prefer TMDB's cleaner name.
  assert.equal(displayTitle('backrooms', 'Backrooms'), 'Backrooms');
  // No TMDB match yet: fall back to the watch title.
  assert.equal(displayTitle('Some Untracked Film', null), 'Some Untracked Film');
});

test('extractTags captures title formats, unseen labels, and HTML format badges', () => {
  assert.deepEqual(extractTags('AMC Scream Unseen January 5 IMAX 70mm'), [
    'IMAX',
    'Scream Unseen',
  ]);
  assert.deepEqual(
    extractFormatsFromHtml('<html><body><img alt="Dolby Cinema Digital"><img alt="RealD 3D"></body></html>'),
    ['Dolby Cinema Digital', 'RealD 3D']
  );
});

test('email classifier handles common AMC subjects and cancellation priority', () => {
  assert.equal(classify('Your AMC Entourage Order Number 123 from 5/2/2026'), 'reservation');
  assert.equal(classify('Ishaan, Thank you for seeing HEAT at AMC'), 'thankyou');
  assert.equal(classify('Your A-List Reservation Cancelation Order Number 123'), 'cancellation');
  assert.equal(classify('AMC Stubs weekly newsletter'), 'unknown');
});

test('date parser utilities produce UTC ISO timestamps', () => {
  assert.equal(parseTimeThenDate('12:05 AM 5/4/2026'), '2026-05-04T00:05:00.000Z');
  assert.equal(parseTimeThenDate('7:30 PM 5/4/2026'), '2026-05-04T19:30:00.000Z');
  assert.equal(parseDateThen24Hr('05/05/2026 19:30'), '2026-05-05T19:30:00.000Z');
});

test('clean strips zero-width characters, non-breaking spaces, and repeated whitespace', () => {
  assert.equal(clean(' A\u200bMC\u00a0Theatre \n\n  10 '), 'AMC Theatre 10');
});

test('AMC reservation parser extracts ticket fields and format tags', () => {
  const result = reservation.parse({
    subject: 'Your AMC Entourage Order Number 987654321 from 5/4/2026',
    html: `
      <body>
        Your Ticket Reservation Details
        Ticket Confirmation#: 11223344
        Dune: Part Two in RealD 3D
        7:30 PM 5/4/2026
        AMC Lincoln Square 13
        The listed showtime is when the feature starts
        Order Number: 987654321
      </body>
    `,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fields.title, 'Dune: Part Two in RealD 3D');
  assert.equal(result.fields.theater_name, 'AMC Lincoln Square 13');
  assert.equal(result.fields.showtime, '2026-05-04T19:30:00.000Z');
  assert.equal(result.fields.order_number, '987654321');
  assert.deepEqual(result.fields.tags, ['RealD 3D']);
});

test('AMC reservation parser skips non-ticket AMC orders', () => {
  const result = reservation.parse({
    subject: 'Your AMC Entourage Order Number 123',
    text: 'Food and Drink Purchase Details Order Number: 123',
  });

  assert.equal(result.ok, true);
  assert.equal(result.skip, true);
  assert.equal(result.reason, 'concession order');
});

test('AMC thank-you parser extracts theater, title, and format badge tags', () => {
  const result = thankyou.parse({
    subject: 'Ishaan, Thank you for seeing HEAT at AMC',
    html: `
      <body>
        Thank You for Visiting AMC Boston Common 19
        We hope you enjoyed seeing Heat Don't Miss these upcoming movies
        <img alt="Dolby Cinema">
      </body>
    `,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fields.title, 'Heat');
  assert.equal(result.fields.theater_name, 'AMC Boston Common 19');
  assert.deepEqual(result.fields.tags, ['Dolby Cinema']);
});

test('AMC thank-you parser falls back to subject title when body title is uppercase', () => {
  const result = thankyou.parse({
    subject: 'Ishaan, Thank you for seeing Heat at AMC',
    text: 'Thank You for Visiting AMC Boston Common 19 We hope you enjoyed seeing HEAT This email',
  });

  assert.equal(result.ok, true);
  assert.equal(result.fields.title, 'Heat');
});

test('AMC cancellation parser extracts order number and optional movie fields', () => {
  const result = cancellation.parse({
    subject: 'Your A-List Reservation Cancelation',
    text: `
      Order Number: 445566
      Confirmation #: 998877 Refund Date: 05/03/2026
      Heat
      05/04/2026 19:30
      AMC Boston Common 19
      Refunded Tickets
    `,
  });

  assert.equal(result.ok, true);
  assert.equal(result.fields.order_number, '445566');
  assert.equal(result.fields.ticket_confirmation, '998877');
  assert.equal(result.fields.title, 'Heat');
  assert.equal(result.fields.theater_name, 'AMC Boston Common 19');
  assert.equal(result.fields.showtime, '2026-05-04T19:30:00.000Z');
});

test('A-List value gates each watch on its month, month override beating the year flag', () => {
  const opts = {
    fee: 25,
    ticket: 16,
    premium: 5,
    premiumFormats: new Set(['IMAX']),
    period: 'all',
    start: new Date(Date.UTC(2025, 0, 1)),
  };
  // Two films in Jan, one in Mar; all standard tickets.
  const watches = [
    { watched_at: '2025-01-10T00:00:00Z', tags: [] },
    { watched_at: '2025-01-20T00:00:00Z', tags: [] },
    { watched_at: '2025-03-05T00:00:00Z', tags: [] },
  ];

  // Whole year a member: 3 tickets ($48) over 2 billed months ($50) → -$2.
  const full = computeAlistValue(watches, {
    ...opts,
    excludedYears: new Set(),
    monthOverride: new Map(),
  });
  assert.equal(full.creditedTickets, 3);
  assert.equal(full.billedMonths, 2);
  assert.equal(full.savings, 48 - 50);

  // Year excluded, but March flipped back on: only the March ticket counts.
  const partial = computeAlistValue(watches, {
    ...opts,
    excludedYears: new Set([2025]),
    monthOverride: new Map([['2025-03', true]]),
  });
  assert.equal(partial.creditedTickets, 1);
  assert.equal(partial.billedMonths, 1);
  assert.equal(partial.savings, 16 - 25);

  // Year a member, but January flipped off: those two tickets drop out.
  const monthOff = computeAlistValue(watches, {
    ...opts,
    excludedYears: new Set(),
    monthOverride: new Map([['2025-01', false]]),
  });
  assert.equal(monthOff.creditedTickets, 1);
  assert.equal(monthOff.billedMonths, 1);
});

test('A-List value reports null savings for a non-member single-month view', () => {
  const opts = {
    fee: 25,
    ticket: 16,
    premium: 5,
    premiumFormats: new Set(),
    excludedYears: new Set(),
  };
  const watches = [{ watched_at: '2025-01-10T00:00:00Z', tags: [] }];

  const excluded = computeAlistValue(watches, {
    ...opts,
    monthOverride: new Map([['2025-01', false]]),
    period: 'month',
    start: new Date(Date.UTC(2025, 0, 1)),
  });
  assert.equal(excluded.savings, null);
  assert.equal(excluded.has_alist, false);

  const member = computeAlistValue(watches, {
    ...opts,
    monthOverride: new Map(),
    period: 'month',
    start: new Date(Date.UTC(2025, 0, 1)),
  });
  assert.equal(member.has_alist, true);
  assert.equal(member.savings, 16 - 25);
});

test('A-List value breaks down by year, newest first, with excluded years carrying null', () => {
  const opts = {
    fee: 25,
    ticket: 16,
    premium: 5,
    premiumFormats: new Set(),
    period: 'all',
    start: new Date(Date.UTC(2024, 0, 1)),
    monthOverride: new Map(),
  };
  const watches = [
    { watched_at: '2024-02-10T00:00:00Z', tags: [] }, // member year
    { watched_at: '2024-02-20T00:00:00Z', tags: [] },
    { watched_at: '2025-05-05T00:00:00Z', tags: [] }, // excluded year
  ];

  const r = computeAlistValue(watches, { ...opts, excludedYears: new Set([2025]) });
  assert.equal(r.byYear.length, 2);
  assert.equal(r.byYear[0].year, 2025); // newest first
  assert.equal(r.byYear[0].is_member, false);
  assert.equal(r.byYear[0].savings, null);
  assert.equal(r.byYear[0].films, 1); // still counts the film for display

  assert.equal(r.byYear[1].year, 2024);
  assert.equal(r.byYear[1].is_member, true);
  assert.equal(r.byYear[1].films, 2);
  assert.equal(r.byYear[1].months, 1);
  assert.equal(r.byYear[1].savings, 32 - 25);
});
