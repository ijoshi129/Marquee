const assert = require('node:assert/strict');
const { test, afterEach } = require('./harness');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const { pool } = require('../db');
const fandango = require('../services/fandango');
const nowPlaying = require('../services/now-playing');

const {
  parsePlace,
  describeGroup,
  localStart,
  splitTitle,
  normalizeTheatres,
  normalizeShowtimes,
  normalizeCalendar,
  normalizeSeatMap,
} = fandango._internal;

const tmdb = require('../services/tmdb');

const realQuery = pool.query;
const realFetch = global.fetch;
const realSearch = tmdb.search;
process.env.TMDB_API_KEY = 'test-key';
const realSearchTheatres = fandango.searchTheatres;
afterEach(() => {
  fandango.searchTheatres = realSearchTheatres;
  nowPlaying._internal.resetLookupBackoff();
  process.env.TMDB_API_KEY = 'test-key';
  pool.query = realQuery;
  global.fetch = realFetch;
  tmdb.search = realSearch;
  fandango.clearCache();
  nowPlaying.clearPosterCache();
});

const amenity = (name) => ({ id: 1, name, description: '' });
const showing = (time, over = {}) => ({
  date: time,
  screenReaderTime: time,
  expired: false,
  isSoldOut: false,
  showtimeHashCode: `v2-${Buffer.from(time + JSON.stringify(over)).toString('hex')}`,
  ticketingDate: '2026-11-13+19:15',
  type: 'available',
  ...over,
});

// Shaped like /napi/theaterMovieShowtimes: variants by format header, each
// with amenity groups that carry the showtimes.
const BOARD = {
  viewModel: {
    date: '2026-11-13',
    movies: [
      {
        id: 101,
        title: 'Clayface (2026)',
        rating: 'PG13',
        runtime: 118,
        genres: ['Horror', 'Thriller', 'Drama', 'Crime'],
        poster: { uri: 'images/x/clayface.jpg', size: { 300: 'https://img/300/clayface.jpg' } },
        variants: [
          {
            filmFormatHeader: 'Standard',
            amenityGroups: [
              {
                hasReservedSeating: true,
                amenities: [amenity('Laser at AMC'), amenity('Reserved seating'), amenity('Closed caption')],
                showtimes: [
                  showing('9:40 PM', { ticketingDate: '2026-11-13+21:40' }),
                  showing('4:10 PM', { ticketingDate: '2026-11-13+16:10', expired: true }),
                ],
              },
            ],
          },
          {
            filmFormatHeader: 'Premium Format',
            amenityGroups: [
              {
                hasReservedSeating: true,
                amenities: [amenity('Dolby Cinema @ AMC'), amenity('Recliner Seats')],
                showtimes: [showing('7:15 PM', { isSoldOut: true })],
              },
              {
                hasReservedSeating: true,
                amenities: [amenity('IMAX with Laser 3D'), amenity('IMAX 3D')],
                showtimes: [showing('8:00 PM', { ticketingDate: '2026-11-13+20:00' })],
              },
            ],
          },
        ],
      },
      {
        id: 102,
        title: 'Dead of Night',
        rating: 'Not Rated',
        runtime: 0,
        genres: [],
        poster: { uri: 'images.fandango.com/redesign/static/img/default_poster.png', size: { 300: 'x' } },
        variants: [
          {
            filmFormatHeader: 'Standard',
            amenityGroups: [
              { amenities: [amenity('Hindi Language')], showtimes: [showing('1:00 AM', { ticketingDate: '2026-11-14+01:00' })] },
            ],
          },
        ],
      },
      { id: 103, title: 'Nothing Left Today', variants: [{ filmFormatHeader: 'Standard', amenityGroups: [] }] },
    ],
  },
};

test('parsePlace takes a ZIP or a city and state, and nothing else', () => {
  assert.deepEqual(parsePlace(' 78701 '), { zipCode: '78701' });
  assert.deepEqual(parsePlace('austin, tx'), { zipCode: '', city: 'austin', state: 'TX' });
  assert.deepEqual(parsePlace("Coeur d'Alene, ID"), { zipCode: '', city: "Coeur d'Alene", state: 'ID' });
  assert.equal(parsePlace('Austin'), null);
  assert.equal(parsePlace('7870'), null);
  assert.equal(parsePlace(''), null);
});

test('describeGroup names the screen and keeps only the notes worth showing', () => {
  const d = (header, ...names) => describeGroup(header, names.map(amenity));
  assert.deepEqual(d('Standard', 'Laser at AMC', 'Reserved seating', 'Closed caption'), { format: 'Standard', notes: [] });
  assert.equal(d('Premium Format', 'Dolby Cinema @ AMC').format, 'Dolby Cinema');
  assert.equal(d('Premium Format', 'IMAX with Laser', 'IMAX').format, 'IMAX');
  assert.equal(d('Premium Format', 'IMAX with Laser 3D', 'IMAX 3D').format, 'IMAX 3D');
  assert.equal(d('Premium Format', 'IMAX 70MM').format, 'IMAX 70mm');
  assert.equal(d('Premium Format', 'PRIME at AMC').format, 'PRIME');
  assert.equal(d('Premium Format', 'XL at AMC').format, 'XL');
  assert.equal(d('3D', 'RealD 3D').format, '3D');
  assert.deepEqual(d('Standard', 'Hindi Language', 'Recliner Seats', 'Open caption').notes, ['Hindi', 'Open caption']);
});

test('localStart keeps the theatre clock and rejects anything else', () => {
  assert.equal(localStart('2026-11-12+19:15'), '2026-11-12T19:15');
  assert.equal(localStart('2026-11-12'), null);
  assert.equal(localStart(undefined), null);
});

test('splitTitle lifts a trailing year off the title', () => {
  assert.deepEqual(splitTitle('Clayface (2026)'), { title: 'Clayface', year: 2026 });
  assert.deepEqual(splitTitle('Dead of Night'), { title: 'Dead of Night', year: null });
  assert.deepEqual(splitTitle('Blade Runner 2049'), { title: 'Blade Runner 2049', year: null });
});

test('normalizeShowtimes groups by screen, sorts by time, and drops films with nothing showing', () => {
  const { date, films } = normalizeShowtimes(BOARD);
  assert.equal(date, '2026-11-13');
  assert.deepEqual(films.map((f) => f.title), ['Clayface', 'Dead of Night']);

  const clay = films[0];
  assert.deepEqual(
    { year: clay.year, rating: clay.rating, runtime: clay.runtime, genres: clay.genres, poster_url: clay.poster_url },
    { year: 2026, rating: 'PG-13', runtime: 118, genres: ['Horror', 'Thriller', 'Drama'], poster_url: 'https://img/300/clayface.jpg' }
  );
  // Premium screens lead, the standard ones close the list.
  assert.deepEqual(clay.formats.map((g) => g.format), ['IMAX 3D', 'Dolby Cinema', 'Standard']);
  assert.deepEqual(clay.formats[1].notes, []);
  assert.equal(clay.formats[1].showtimes[0].sold_out, true);

  const standard = clay.formats[2].showtimes;
  assert.deepEqual(standard.map((s) => s.starts_at), ['2026-11-13T16:10', '2026-11-13T21:40']);
  assert.deepEqual(standard.map((s) => s.past), [true, false]);
  assert.deepEqual(standard.map((s) => s.label), ['4:10 PM', '9:40 PM']);
  assert.equal(films[1].formats[0].showtimes[0].label, '1:00 AM');
  assert.match(standard[1].hash, /^v2-[0-9a-f]+$/);

  const dead = films[1];
  // The placeholder poster and "Not Rated" are no information, so both are null.
  assert.deepEqual({ rating: dead.rating, runtime: dead.runtime, poster_url: dead.poster_url }, { rating: null, runtime: null, poster_url: null });
  assert.equal(dead.formats[0].showtimes[0].starts_at, '2026-11-14T01:00');
});

test('normalizeShowtimes tells an unknown theatre from a changed response', () => {
  assert.throws(() => normalizeShowtimes({ error: true }), (e) => e.status === 404);
  assert.throws(() => normalizeShowtimes({ something: 'else' }), (e) => e.status === 502);
});

test('normalizeTheatres keeps AMC theatres only', () => {
  const out = normalizeTheatres({
    theaters: [
      { id: 'AANCC', name: 'AMC Barton Creek Square 14', chainCode: 'AMC', address1: '2901 Capital of Texas Hwy', city: 'Austin', state: 'TX', zip: '78746', distance: 4.04 },
      { id: 'AATHS', name: 'Alamo Drafthouse', chainCode: 'ALAM' },
      { id: 'bad id', name: 'AMC Broken', chainCode: 'AMC' },
    ],
  });
  assert.deepEqual(out, [
    { id: 'AANCC', name: 'AMC Barton Creek Square 14', address: '2901 Capital of Texas Hwy', city: 'Austin', state: 'TX', zip: '78746', distance_miles: 4 },
  ]);
  assert.deepEqual(normalizeTheatres({}), []);
});

test('normalizeCalendar returns the dates that have showtimes', () => {
  assert.deepEqual(normalizeCalendar({ showtimeDates: ['2026-11-13', 'junk', '2026-11-14'], firstShowtime: '2026-11-13' }), {
    dates: ['2026-11-13', '2026-11-14'],
    first: '2026-11-13',
  });
  assert.deepEqual(normalizeCalendar(null), { dates: [], first: null });
});

const SEATS = {
  theaterName: 'AMC Empire 25',
  auditoriumId: 21,
  totalWidth: 200,
  totalHeight: 100,
  totalAvailableSeatCount: 3,
  totalSeatCount: 4,
  seats: [
    { id: 'A2', x: 0, y: 0, width: 45, height: 45, type: 'standard', status: 'A' },
    { id: 'A1', x: 60, y: 0, width: 45, height: 45, type: 'standard', status: 'R' },
    { id: 'B1', x: 0, y: 55, width: 45, height: 45, type: 'companion', status: 'A' },
    { id: 'B2', x: 60, y: 55, width: 45, height: 45, type: 'wheelchair', status: 'O' },
    { id: 'ZZ', type: 'standard', status: 'A' },
  ],
  areas: [
    {
      ticketInfo: [
        { desc: 'Adult', price: '21.19' },
        { desc: 'Child', price: '18.19' },
        { desc: 'Adult', price: '25.00' },
      ],
    },
  ],
};

test('normalizeSeatMap reads open seats, kinds, rows and prices', () => {
  const m = normalizeSeatMap(SEATS);
  assert.deepEqual(
    { theatre: m.theatre, auditorium: m.auditorium, available: m.available, total: m.total, width: m.width, height: m.height },
    { theatre: 'AMC Empire 25', auditorium: '21', available: 3, total: 4, width: 200, height: 100 }
  );
  // The seat with no position cannot be drawn and is left out.
  assert.deepEqual(m.seats.map((s) => [s.id, s.row, s.kind, s.open]), [
    ['A2', 'A', 'standard', true],
    ['A1', 'A', 'standard', false],
    ['B1', 'B', 'companion', true],
    ['B2', 'B', 'wheelchair', true],
  ]);
  assert.deepEqual(m.prices, [{ label: 'Adult', price: 21.19 }, { label: 'Child', price: 18.19 }]);
  assert.throws(() => normalizeSeatMap({}), (e) => e.status === 502);
});

function stubFetch(handler) {
  const calls = [];
  global.fetch = async (url) => {
    calls.push(String(url));
    const { status = 200, body } = handler(new URL(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  };
  return calls;
}

test('showtimes asks the source once and serves the next caller from the cache', async () => {
  const calls = stubFetch(() => ({ body: BOARD }));
  const [a, b] = await Promise.all([fandango.showtimes('aaore', '2026-11-13'), fandango.showtimes('AAORE', '2026-11-13')]);
  assert.equal(a, b);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /\/napi\/theaterMovieShowtimes\/AAORE\?chainCode=AMC&startDate=2026-11-13/);
});

test('a failed request is not cached, and bad input never reaches the source', async () => {
  let n = 0;
  const calls = stubFetch(() => (++n === 1 ? { status: 503, body: {} } : { body: BOARD }));
  await assert.rejects(fandango.showtimes('AAORE', '2026-11-13'), /HTTP 503/);
  assert.equal((await fandango.showtimes('AAORE', '2026-11-13')).films.length, 2);
  assert.equal(calls.length, 2);

  await assert.rejects(fandango.showtimes('../../etc', '2026-11-13'), (e) => e.status === 400);
  await assert.rejects(fandango.showtimes('AAORE', 'tomorrow'), (e) => e.status === 400);
  await assert.rejects(fandango.seatMap('a/b'), (e) => e.status === 400);
  await assert.rejects(fandango.searchTheatres('somewhere'), (e) => e.status === 400);
  assert.equal(calls.length, 2);
});

test('seatCounts leaves out a showing that has gone off sale', async () => {
  stubFetch((url) => (url.pathname.endsWith('/v2-gone0000') ? { status: 404, body: [] } : { body: SEATS }));
  assert.deepEqual(await fandango.seatCounts(['v2-good0000', 'v2-gone0000']), {
    'v2-good0000': { available: 3, total: 4 },
  });
  await assert.rejects(fandango.seatMap('v2-gone0000'), (e) => e.status === 404 && /no longer on sale/.test(e.message));
});

test('theatre settings keep one home, drop duplicates and junk', () => {
  const { cleanTheatres } = nowPlaying._internal;
  const home = { id: 'aaore', name: ' AMC Empire 25 ', city: 'New York', state: 'NY', extra: 'x' };
  assert.deepEqual(
    cleanTheatres({
      home,
      saved: [home, { id: 'AAQCR', name: 'AMC 34th Street 14' }, { id: 'AAQCR', name: 'Again' }, { id: 'nope', name: 'x' }, { id: 'AABQI' }, null],
    }),
    {
      home: { id: 'AAORE', name: 'AMC Empire 25', city: 'New York', state: 'NY' },
      saved: [{ id: 'AAQCR', name: 'AMC 34th Street 14', city: null, state: null }],
    }
  );
  assert.deepEqual(cleanTheatres(undefined), { home: null, saved: [] });
});

test('flagFilms marks seen and booked films without unmasking a booked Screen Unseen', async () => {
  pool.query = async () => ({
    rows: [
      { id: 'w1', title: 'Clayface in Dolby Cinema', status: 'watched', showtime: null, tmdb_title: 'Clayface' },
      { id: 'w2', title: 'Wicker', status: 'pending', showtime: '2026-11-15T19:00:00.000Z', tmdb_title: 'Wicker' },
      // Identified early: the real film must not light up as booked.
      { id: 'w3', title: 'AMC Screen Unseen November 16 2026', status: 'pending', showtime: '2026-11-16T19:00:00.000Z', tmdb_title: 'Wildwood' },
    ],
  });
  const out = await nowPlaying.flagFilms([{ title: 'Clayface' }, { title: 'Wicker' }, { title: 'Wildwood' }, { title: 'Mouse' }]);
  assert.deepEqual(out.map((f) => [f.title, f.seen_watch_id, f.booked && f.booked.watch_id]), [
    ['Clayface', 'w1', null],
    ['Wicker', null, 'w2'],
    ['Wildwood', null, null],
    ['Mouse', null, null],
  ]);
});

test('flagFilms returns the board untouched when the diary cannot be read', async () => {
  pool.query = async () => {
    throw new Error('db down');
  };
  const films = [{ title: 'Clayface' }];
  assert.equal(await nowPlaying.flagFilms(films), films);
});

const result = (title, release_year, popularity, poster = `https://image.tmdb.org/t/p/w500/${title.replace(/\W/g, '')}${release_year}.jpg`) => ({
  tmdb_id: release_year,
  title,
  original_title: title,
  release_year,
  popularity,
  poster_url: poster,
});

test('an Unseen listing gets the Unseen artwork, whatever poster the source sent', async () => {
  tmdb.search = async () => {
    throw new Error('an Unseen must not be looked up');
  };
  const out = await nowPlaying.fillPosters([
    { title: 'AMC Screen Unseen: November 16', year: null, poster_url: 'https://img/pg-rated.jpg' },
    { title: 'AMC Scream Unseen: November 30', year: null, poster_url: null },
  ]);
  assert.deepEqual(out.map((f) => [f.unseen, f.poster_url]), [
    ['screen', '/screen-unseen.avif'],
    ['scream', '/scream-unseen.avif'],
  ]);
});

test('a film with no poster gets the same-titled film from TMDB, nearest in year', async () => {
  const asked = [];
  tmdb.search = async (q) => {
    asked.push(q);
    return [
      result('Dead of Night', 1945, 12),
      result('Dead of Night', 2026, 3),
      result('Dead of Night Returns', 2026, 90),
      result('Dead of Night', 2025, 50, null),
    ];
  };
  const [has, lacks, undated] = await nowPlaying.fillPosters([
    { title: 'Clayface', year: 2026, poster_url: 'https://img/clayface.jpg' },
    { title: 'Dead of Night', year: 2026, poster_url: null },
    { title: 'Dead of Night', year: null, poster_url: null },
  ]);
  // A film that already has a poster is never looked up.
  assert.equal(has.poster_url, 'https://img/clayface.jpg');
  assert.equal(lacks.poster_url, 'https://image.tmdb.org/t/p/w185/DeadofNight2026.jpg');
  // With no year to go on, the best-known film of that title.
  assert.equal(undated.poster_url, 'https://image.tmdb.org/t/p/w185/DeadofNight1945.jpg');
  assert.deepEqual(asked, ['Dead of Night', 'Dead of Night']);
});

test('TMDB posters: no near match means no poster, and answers are remembered', async () => {
  let calls = 0;
  tmdb.search = async () => {
    calls += 1;
    return [result('Ghost Soldier', 1999, 40), result('Ghost Soldiers', 2026, 80)];
  };
  // Same title but a film from another era, and a near-miss title: neither will do.
  assert.equal(await nowPlaying.tmdbPoster('Ghost Soldier', 2026), null);
  assert.equal(await nowPlaying.tmdbPoster('Ghost Soldier (2026)'.replace(' (2026)', ''), 2026), null);
  assert.equal(calls, 1);
  assert.equal(await nowPlaying.tmdbPoster('', 2026), null);
});

test('a failed TMDB lookup leaves the film alone and is tried again next time', async () => {
  let calls = 0;
  tmdb.search = async () => {
    calls += 1;
    if (calls === 1) throw new Error('TMDB 503');
    return [result('Mouse', 2026, 5)];
  };
  const film = { title: 'Mouse', year: 2026, poster_url: null };
  assert.equal((await nowPlaying.fillPosters([film]))[0].poster_url, null);
  assert.equal((await nowPlaying.fillPosters([film]))[0].poster_url, 'https://image.tmdb.org/t/p/w185/Mouse2026.jpg');
});

test('with no TMDB key, posters are skipped without a lookup', async () => {
  delete process.env.TMDB_API_KEY;
  tmdb.search = async () => {
    throw new Error('must not be called');
  };
  assert.equal(await nowPlaying.tmdbPoster('Mouse', 2026), null);
});

test('a booked Unseen is matched to its listing by kind and day', async () => {
  const { unseenKeyFromTitle, unseenKeyFromWatch } = nowPlaying._internal;
  assert.equal(unseenKeyFromTitle('AMC Screen Unseen: November 16'), 'unseen:screen:11-16');
  assert.equal(unseenKeyFromTitle('AMC Scream Unseen - Dec 7, 2026'), 'unseen:scream:12-7');
  assert.equal(unseenKeyFromTitle('AMC Screen Unseen'), null);
  assert.equal(unseenKeyFromTitle('Clayface'), null);
  assert.equal(unseenKeyFromWatch({ title: 'AMC Screen Unseen', showtime: '2026-11-16T19:00:00.000Z' }), 'unseen:screen:11-16');
  assert.equal(unseenKeyFromWatch({ title: 'Clayface', showtime: '2026-11-16T19:00:00.000Z' }), null);

  pool.query = async () => ({
    rows: [
      { id: 'u1', title: 'AMC Screen Unseen 11/16/2026', status: 'pending', showtime: '2026-11-16T19:00:00.000Z', tmdb_title: 'Wildwood' },
    ],
  });
  const out = await nowPlaying.flagFilms([
    { title: 'AMC Screen Unseen: November 16' },
    { title: 'AMC Screen Unseen: November 23' },
    { title: 'AMC Scream Unseen: November 16' },
    { title: 'Wildwood' },
  ]);
  assert.deepEqual(out.map((f) => f.booked && f.booked.watch_id), ['u1', null, null, null]);
});

// app_state plus the diary's theatre counts, enough for visitedTheatres.
function stubDiary(counts, state = {}) {
  const store = new Map(Object.entries(state));
  pool.query = async (sql, params) => {
    if (/FROM theaters t/.test(sql)) return { rows: counts.map(([name, visits]) => ({ name, visits })) };
    if (/^\s*INSERT INTO app_state/.test(sql)) {
      store.set(params[0], params[1]);
      return { rows: [] };
    }
    if (/FROM app_state/.test(sql)) return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
    throw new Error(`unexpected query: ${sql}`);
  };
  return store;
}

const HOME = { id: 'AABPS', name: 'AMC Monmouth Mall 15', city: 'Eatontown', state: 'NJ' };
const NEAR_HOME = [
  { id: 'AABPS', name: 'AMC Monmouth Mall 15', city: 'Eatontown', state: 'NJ' },
  { id: 'AABPR', name: 'AMC Freehold 14', city: 'Freehold', state: 'NJ' },
  { id: 'AAHRP', name: 'AMC Brunswick Square 13', city: 'East Brunswick', state: 'NJ' },
];

test("the diary's theatres are matched near home, most visited first, and remembered", async () => {
  const store = stubDiary([
    ['AMC Brunswick Square 13', 46],
    ['AMC Monmouth Mall 15', 11],
    ['AMC Somewhere On Holiday 8', 2],
    ['AMC Freehold 14', 1],
  ]);
  const asked = [];
  fandango.searchTheatres = async (q) => {
    asked.push(q);
    return NEAR_HOME;
  };
  const { visitedTheatres } = nowPlaying._internal;
  const out = await visitedTheatres({ home: HOME, saved: [] });
  // The theatre that is not near home has no listing to open, so it is left out.
  assert.deepEqual(out.map((t) => [t.id, t.name, t.visits]), [
    ['AAHRP', 'AMC Brunswick Square 13', 46],
    ['AABPS', 'AMC Monmouth Mall 15', 11],
    ['AABPR', 'AMC Freehold 14', 1],
  ]);
  assert.deepEqual(asked, ['Eatontown, NJ']);
  assert.ok(JSON.parse(store.get('now_playing_visited'))['amc brunswick square 13']);
});

test("the diary's theatres need no lookup once every name is known", async () => {
  stubDiary([['AMC Brunswick Square 13', 46], ['AMC Monmouth Mall 15', 11]], {
    now_playing_visited: JSON.stringify({ 'amc brunswick square 13': NEAR_HOME[2] }),
  });
  fandango.searchTheatres = async () => {
    throw new Error('must not be called');
  };
  const out = await nowPlaying._internal.visitedTheatres({ home: HOME, saved: [] });
  assert.deepEqual(out.map((t) => t.id), ['AAHRP', 'AABPS']);
});

test('a failed theatre lookup still lists what is known, and is not retried at once', async () => {
  stubDiary([['AMC Brunswick Square 13', 46], ['AMC Monmouth Mall 15', 11]]);
  let calls = 0;
  fandango.searchTheatres = async () => {
    calls += 1;
    throw new Error('HTTP 503');
  };
  const view = await nowPlaying.theatresForView({ home: HOME, saved: [] });
  assert.deepEqual(view.visited.map((t) => t.id), ['AABPS']);
  await nowPlaying.theatresForView({ home: HOME, saved: [] });
  assert.equal(calls, 1);
});

test('with no home theatre or an empty diary there is nothing to list', async () => {
  fandango.searchTheatres = async () => {
    throw new Error('must not be called');
  };
  stubDiary([['AMC Brunswick Square 13', 46]]);
  assert.deepEqual((await nowPlaying.theatresForView({ home: null, saved: [] })).visited, []);
  stubDiary([]);
  assert.deepEqual((await nowPlaying.theatresForView({ home: HOME, saved: [] })).visited, []);
});

test('theatresForView never loses the saved theatres to a diary failure', async () => {
  pool.query = async () => {
    throw new Error('db down');
  };
  assert.deepEqual(await nowPlaying.theatresForView({ home: HOME, saved: [] }), { home: HOME, saved: [], visited: [] });
});
