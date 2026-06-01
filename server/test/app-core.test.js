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
const reservation = require('../parsers/amc-reservation');
const thankyou = require('../parsers/amc-thankyou');
const cancellation = require('../parsers/amc-cancellation');
const { clean, parseDateThen24Hr, parseTimeThenDate } = require('../parsers/util');

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
