const assert = require('node:assert/strict');
const { test, afterEach } = require('./harness');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const tmdb = require('../services/tmdb');
const unseenLookup = require('../services/unseen-lookup');
const unseenGuess = require('../services/unseen-guess');

const { assess, usOpening, fitOf } = unseenGuess._internal;

const real = { discover: tmdb.discoverOpening, facts: tmdb.releaseFacts, clues: unseenLookup.cluesFor, key: process.env.TMDB_API_KEY };
afterEach(() => {
  tmdb.discoverOpening = real.discover;
  tmdb.releaseFacts = real.facts;
  unseenLookup.cluesFor = real.clues;
  if (real.key === undefined) delete process.env.TMDB_API_KEY;
  else process.env.TMDB_API_KEY = real.key;
  unseenGuess.clearCache();
});

// A Monday Unseen: PG, AMC says 1h54m.
const SCREENING = '2026-11-16';
const CTX = { screening: SCREENING, kind: 'screen', rating: 'PG', runtime: 114, studios: { Roadside: 3, NEON: 2 } };

const film = (over = {}) => ({
  tmdb_id: 1,
  title: 'A Film',
  first_release: '2026-11-27',
  runtime_minutes: 109,
  genres: ['Drama'],
  companies: ['Some Company'],
  poster_url: 'https://image.tmdb.org/t/p/w500/x.jpg',
  us_dates: [{ date: '2026-11-27', type: 3 }],
  us_ratings: ['PG'],
  ...over,
});

test('usOpening takes the wide opening after the screening, else a limited one', () => {
  assert.equal(usOpening(film({ us_dates: [{ date: '2026-11-20', type: 2 }, { date: '2026-11-27', type: 3 }] }), SCREENING), '2026-11-27');
  assert.equal(usOpening(film({ us_dates: [{ date: '2026-11-20', type: 2 }] }), SCREENING), '2026-11-20');
  // A festival date before the screening is not an opening.
  assert.equal(usOpening(film({ us_dates: [{ date: '2026-09-05', type: 2 }] }), SCREENING), null);
});

test('assess: the Friday of the following week with a fitting runtime is the strongest case', () => {
  const v = assess(film(), CTX);
  assert.equal(v.opens, '2026-11-27');
  assert.deepEqual(v.reasons, ['Opens Nov 27, 11 days after', 'Rated PG', "1h 49m, which fits AMC's 1h 54m"]);
  assert.equal(fitOf(v.points), 'strong');
});

test('assess: opening that same Friday ranks below the following one, and later ranks lower still', () => {
  const at = (date) => assess(film({ us_dates: [{ date, type: 3 }] }), CTX).points;
  assert.ok(at('2026-11-27') > at('2026-11-20'));
  assert.ok(at('2026-11-20') > at('2026-12-04'));
});

test('assess rules out what cannot be it', () => {
  // Wrong rating.
  assert.equal(assess(film({ us_ratings: ['R'] }), CTX), null);
  // Horror is never a Screen Unseen, and a Scream Unseen is always horror.
  assert.equal(assess(film({ genres: ['Horror', 'Thriller'] }), CTX), null);
  assert.equal(assess(film(), { ...CTX, kind: 'scream' }), null);
  assert.ok(assess(film({ genres: ['Horror'] }), { ...CTX, kind: 'scream' }));
  // Opens too far out, or is already out.
  assert.equal(assess(film({ us_dates: [{ date: '2026-12-25', type: 3 }] }), CTX), null);
  assert.equal(assess(film({ us_dates: [{ date: '2026-11-06', type: 3 }] }), CTX), null);
  // A re-release of an old film.
  assert.equal(assess(film({ first_release: '2011-11-23' }), CTX), null);
  // A runtime far outside what AMC's figure allows.
  assert.equal(assess(film({ runtime_minutes: 150 }), CTX), null);
  assert.equal(assess(film({ runtime_minutes: 80 }), CTX), null);
});

test('assess follows the megathread rule for runtime: AMC is 7 short to 17 long', () => {
  const fits = (mins) => (assess(film({ runtime_minutes: mins }), CTX) || { reasons: [] }).reasons.some((r) => /which fits/.test(r));
  // AMC says 114, so the film is between 97 and 121 minutes.
  assert.deepEqual([96, 97, 109, 121, 122].map(fits), [false, true, true, true, false]);
  // Just outside is kept as a stretch, not thrown away.
  assert.match(assess(film({ runtime_minutes: 124 }), CTX).reasons.join(' '), /a stretch/);
});

test('assess keeps a film with gaps in its record, and says what is missing', () => {
  const v = assess(film({ us_ratings: [], runtime_minutes: null }), CTX);
  assert.deepEqual(v.reasons, ['Opens Nov 27, 11 days after', 'No rating listed yet', 'Runtime not listed yet']);
  assert.ok(v.points < assess(film(), CTX).points);
});

test('assess notes a studio that has supplied an Unseen before', () => {
  const v = assess(film({ companies: ['Roadside Attractions'] }), CTX);
  assert.match(v.reasons.join(' | '), /Roadside has supplied 3 Unseens before/);
  assert.ok(v.points > assess(film(), CTX).points);
  // A name that merely contains the letters is not a match.
  assert.doesNotMatch(assess(film({ companies: ['Neonlight Films'] }), CTX).reasons.join(' '), /NEON/);
});

function stubTmdb(films) {
  const calls = { discover: [], facts: 0 };
  tmdb.discoverOpening = async (q) => {
    calls.discover.push(q);
    const list = films.map((f) => ({ tmdb_id: f.tmdb_id, title: f.title, popularity: f.popularity || 5 }));
    return q.certification ? list.filter((f, i) => films[i].us_ratings.includes(q.certification)) : list;
  };
  tmdb.releaseFacts = async (id) => {
    calls.facts += 1;
    return films.find((f) => f.tmdb_id === id);
  };
  return calls;
}

test('guesses ranks the films that fit and leaves out the ones that cannot be it', async () => {
  process.env.TMDB_API_KEY = 'test-key';
  unseenLookup.cluesFor = async (date, kind) => {
    assert.deepEqual([date, kind], [SCREENING, 'screen']);
    return { revealed: null, rating: 'PG', runtime: 114, studios: { Roadside: 3 } };
  };
  const calls = stubTmdb([
    film({ tmdb_id: 1, title: 'Next Friday', popularity: 4 }),
    film({ tmdb_id: 2, title: 'This Friday', us_dates: [{ date: '2026-11-20', type: 3 }], runtime_minutes: 102 }),
    film({ tmdb_id: 3, title: 'Wrong Rating', us_ratings: ['R'], popularity: 90 }),
    film({ tmdb_id: 4, title: 'Horror One', genres: ['Horror'], popularity: 80 }),
    film({ tmdb_id: 5, title: 'Unrated Indie', us_ratings: [], companies: ['Roadside Attractions'] }),
    film({ tmdb_id: 6, title: 'Old Favourite', first_release: '2011-11-23', popularity: 99 }),
  ]);
  const out = await unseenGuess.guesses({ date: SCREENING, kind: 'screen', rating: 'PG' });
  assert.deepEqual(out.basis, { rating: 'PG', runtime_minutes: 114, from_megathread: true });
  assert.equal(out.revealed, null);
  assert.deepEqual(out.candidates.map((c) => [c.title, c.fit]), [
    ['Next Friday', 'strong'],
    // No rating on record yet, but the right day, the right length and a
    // studio with form: still a strong fit, just behind the rated one.
    ['Unrated Indie', 'strong'],
    ['This Friday', 'possible'],
  ]);
  assert.equal(out.candidates[0].poster_url, 'https://image.tmdb.org/t/p/w185/x.jpg');
  assert.equal(out.candidates[0].year, 2026);
  // The window is the three weeks or so after the screening.
  assert.deepEqual(calls.discover.map((q) => [q.from, q.to, q.certification]), [
    ['2026-11-17', '2026-12-10', 'PG'],
    ['2026-11-17', '2026-12-10', undefined],
  ]);

  // Asked again, it is answered from memory.
  await unseenGuess.guesses({ date: SCREENING, kind: 'screen', rating: 'PG' });
  assert.equal(calls.discover.length, 2);
});

test('guesses falls back to the listing rating when Reddit cannot be read', async () => {
  process.env.TMDB_API_KEY = 'test-key';
  unseenLookup.cluesFor = async () => {
    throw new Error('Reddit 403');
  };
  stubTmdb([film({ tmdb_id: 1, title: 'Next Friday' })]);
  const out = await unseenGuess.guesses({ date: SCREENING, kind: 'screen', rating: 'PG' });
  assert.deepEqual(out.basis, { rating: 'PG', runtime_minutes: null, from_megathread: false });
  assert.deepEqual(out.candidates[0].reasons, ['Opens Nov 27, 11 days after', 'Rated PG']);
});

test('guesses hands over the reveal when Reddit already has it, and looks nothing up', async () => {
  process.env.TMDB_API_KEY = 'test-key';
  unseenLookup.cluesFor = async () => ({ revealed: { title: 'Hershey' }, rating: 'PG', runtime: null, studios: {} });
  const calls = stubTmdb([film()]);
  const out = await unseenGuess.guesses({ date: SCREENING, kind: 'screen', rating: 'PG' });
  assert.deepEqual([out.revealed, out.candidates, calls.discover.length], ['Hershey', [], 0]);
});

test('guesses says so when there is no TMDB key to search with', async () => {
  delete process.env.TMDB_API_KEY;
  unseenLookup.cluesFor = async () => ({ revealed: null, rating: 'PG', runtime: 114, studios: {} });
  const calls = stubTmdb([film()]);
  const out = await unseenGuess.guesses({ date: SCREENING, kind: 'screen', rating: 'PG' });
  assert.deepEqual([out.needs_key, out.candidates.length, calls.discover.length, out.basis.runtime_minutes], [true, 0, 0, 114]);
});
