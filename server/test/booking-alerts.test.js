const assert = require('node:assert/strict');
const { test, afterEach } = require('./harness');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const { pool } = require('../db');
const fandango = require('../services/fandango');
const nowPlaying = require('../services/now-playing');
const notifications = require('../services/notifications');
const unseenLookup = require('../services/unseen-lookup');
const jobStatus = require('../services/job-status');
const alerts = require('../services/now-playing-alerts');
const reminder = require('../workers/showtime-reminder');

const real = {
  query: pool.query,
  notify: notifications.notify,
  seatMap: fandango.seatMap,
  showtimes: fandango.showtimes,
  view: nowPlaying.theatresForView,
  flag: nowPlaying.flagFilms,
  upcoming: unseenLookup.upcomingUnseens,
};
afterEach(() => {
  pool.query = real.query;
  notifications.notify = real.notify;
  fandango.seatMap = real.seatMap;
  fandango.showtimes = real.showtimes;
  nowPlaying.theatresForView = real.view;
  nowPlaying.flagFilms = real.flag;
  unseenLookup.upcomingUnseens = real.upcoming;
  jobStatus.clearCache();
});

// app_state in memory, plus whatever rows a test hands the watches query.
function stubDb(state = {}, watches = []) {
  const store = new Map(Object.entries(state).map(([k, v]) => [k, JSON.stringify(v)]));
  pool.query = async (sql, params) => {
    if (/FROM watches w/.test(sql)) return { rows: watches };
    if (/^\s*INSERT INTO app_state/.test(sql)) {
      store.set(params[0], params[1]);
      return { rows: [] };
    }
    if (/FROM app_state/.test(sql)) return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
    throw new Error(`unexpected query: ${sql}`);
  };
  return { get: (k) => (store.has(k) ? JSON.parse(store.get(k)) : undefined) };
}

function captureNotify() {
  const sent = [];
  const seen = new Set();
  notifications.notify = async (n) => {
    if (n.dedupeKey && seen.has(n.dedupeKey)) return null;
    seen.add(n.dedupeKey);
    sent.push(n);
    return { id: sent.length, ...n };
  };
  return sent;
}

// 7:00 PM in New Jersey on Nov 16 is midnight UTC on the 17th.
const SHOW = '2026-11-16T19:00:00.000Z';
const REAL_START = Date.parse('2026-11-17T00:00:00Z');
const MIN = 60 * 1000;
const booking = (over = {}) => ({ id: 'w1', title: 'AMC Screen Unseen: November 16', showtime: SHOW, auditorium: '1', seats: ['G8'], theater_name: 'AMC Monmouth Mall 15', runtime_minutes: null, ...over });

test('reminder: says where to go, where to sit and when it lets out', () => {
  const { reminderFor } = reminder._internal;
  assert.deepEqual(reminderFor(booking({ title: 'Wicked: For Good', runtime_minutes: '138', seats: ['F8', 'F9'] })), {
    kind: 'showtime',
    title: 'Wicked: For Good at 7:00 PM',
    body: 'AMC Monmouth Mall 15 · Auditorium 1 · Seats F8, F9. Film starts about 7:25 PM, out by about 9:43 PM.',
    payload: { watch_id: 'w1' },
    dedupeKey: `showtime:w1:${SHOW}`,
  });
  // No runtime (an Unseen) and nothing known about the room: say what is known.
  const bare = reminderFor(booking({ auditorium: null, seats: null, theater_name: null }));
  assert.equal(bare.title, 'AMC Screen Unseen: November 16 at 7:00 PM');
  assert.equal(bare.body, 'Film starts about 7:25 PM.');
});

test('reminder: due inside the lead time, not before it and not once the show has begun', () => {
  const { isDue } = reminder._internal;
  const lead = reminder.LEAD_MIN * MIN;
  assert.equal(isDue(booking(), REAL_START - lead - MIN), false);
  assert.equal(isDue(booking(), REAL_START - lead), true);
  assert.equal(isDue(booking(), REAL_START - 10 * MIN), true);
  assert.equal(isDue(booking(), REAL_START), false);
  assert.equal(isDue(booking(), REAL_START + MIN), false);
});

test('reminder: one push per booking however often the check runs', async () => {
  stubDb({}, [booking(), booking({ id: 'w2', showtime: '2026-11-18T19:00:00.000Z' })]);
  const sent = captureNotify();
  const now = REAL_START - 90 * MIN;
  assert.equal(await reminder.checkOnce(now), 1);
  assert.equal(await reminder.checkOnce(now + 5 * MIN), 0);
  assert.deepEqual(sent.map((n) => n.payload.watch_id), ['w1']);
});

const watch = (over = {}) => ({ hash: 'v2-abcdef0123', title: 'Clayface', starts_at: '2026-11-21T19:00', label: '7:00 PM', format: 'IMAX', theatre_id: 'AABPS', theatre_name: 'AMC Monmouth Mall 15', ...over });
const NOW = Date.parse('2026-11-20T15:00:00Z');

test('watching: only a showing that can be watched is kept, and one that has started is dropped', async () => {
  const db = stubDb();
  assert.equal(await alerts.watchShowing({ ...watch(), hash: 'no good' }), null);
  assert.equal(await alerts.watchShowing({ ...watch(), starts_at: 'tonight' }), null);
  assert.ok(await alerts.watchShowing({ ...watch(), notified_full: true }));
  // A caller cannot pre-mark it as already announced.
  assert.equal(db.get('now_playing_watching')[0].notified_full, false);
  assert.equal((await alerts.listWatching(NOW)).length, 1);
  assert.equal((await alerts.listWatching(Date.parse('2026-11-22T00:00:01Z'))).length, 0);
  await alerts.unwatchShowing('v2-abcdef0123');
  assert.equal((await alerts.listWatching(NOW)).length, 0);
});

test('watching: tells once when a quarter of the seats are left, and once when it sells out', async () => {
  const db = stubDb({ now_playing_watching: [watch()] });
  const sent = captureNotify();
  let seats = { available: 40, total: 74 };
  fandango.seatMap = async () => seats;

  assert.equal((await alerts.checkWatching(NOW)).sent, 0);
  seats = { available: 18, total: 74 };
  assert.equal((await alerts.checkWatching(NOW)).sent, 1);
  assert.equal((await alerts.checkWatching(NOW)).sent, 0);
  seats = { available: 0, total: 74 };
  assert.equal((await alerts.checkWatching(NOW)).sent, 1);
  assert.equal((await alerts.checkWatching(NOW)).sent, 0);

  assert.deepEqual(sent.map((n) => [n.kind, n.title, n.body]), [
    ['nowplaying', 'Filling up: Clayface', '18 of 74 seats left · Sat, Nov 21 7:00 PM · Monmouth Mall 15, IMAX'],
    ['nowplaying', 'Sold out: Clayface', 'Sat, Nov 21 7:00 PM · Monmouth Mall 15, IMAX'],
  ]);
  assert.deepEqual(sent[0].payload, { now_playing: { theatre: 'AABPS', date: '2026-11-21' } });
  assert.deepEqual([db.get('now_playing_watching')[0].notified_low, db.get('now_playing_watching')[0].notified_full], [true, true]);
});

test('watching: a showing found already sold out is announced once, not twice', async () => {
  stubDb({ now_playing_watching: [watch()] });
  const sent = captureNotify();
  fandango.seatMap = async () => ({ available: 0, total: 74 });
  await alerts.checkWatching(NOW);
  await alerts.checkWatching(NOW);
  assert.deepEqual(sent.map((n) => n.title), ['Sold out: Clayface']);
});

test('watching: a showing gone off sale is dropped, a failed lookup is kept and reported', async () => {
  const db = stubDb({ now_playing_watching: [watch(), watch({ hash: 'v2-gone000000', title: 'Gone' })] });
  captureNotify();
  fandango.seatMap = async (hash) => {
    const err = new Error(hash === 'v2-gone000000' ? 'off sale' : 'HTTP 503');
    err.status = hash === 'v2-gone000000' ? 404 : 502;
    throw err;
  };
  const out = await alerts.checkWatching(NOW);
  assert.equal(out.watching, 1);
  assert.match(out.error.message, /503/);
  assert.deepEqual(db.get('now_playing_watching').map((w) => w.title), ['Clayface']);
});

const HOME = { id: 'AABPS', name: 'AMC Monmouth Mall 15' };
const OTHER = { id: 'AAHRP', name: 'AMC Brunswick Square 13' };
const unseenFilm = (times) => ({ id: 900, title: 'AMC Screen Unseen: December 14', formats: [{ format: 'Standard', notes: [], showtimes: times.map((label) => ({ label, past: false })) }] });

test('unseens: an upcoming one on sale at your theatres is announced once, with its clues', async () => {
  const db = stubDb();
  const sent = captureNotify();
  nowPlaying.theatresForView = async () => ({ home: HOME, saved: [], visited: [OTHER] });
  nowPlaying.flagFilms = async (films) => films.map((f) => ({ ...f, booked: null }));
  unseenLookup.upcomingUnseens = async () => [
    { date: '2026-11-16', type: 'screen', rating: 'PG', runtime: 114 },
    { date: '2026-12-14', type: 'screen', rating: 'PG-13', runtime: 129 },
    { date: '2026-12-21', type: 'scream', rating: 'R', runtime: 115 },
  ];
  const asked = [];
  let listed = { AABPS: true, AAHRP: false };
  fandango.showtimes = async (id, date) => {
    asked.push(`${id} ${date}`);
    return { date, films: date === '2026-12-14' && listed[id] ? [unseenFilm(['7:00 PM'])] : [{ id: 1, title: 'Clayface', formats: [] }] };
  };

  assert.deepEqual(await alerts.checkUnseens(NOW), { upcoming: 2, sent: 1 });
  // The one that has already happened is not looked at.
  assert.deepEqual(asked, ['AABPS 2026-12-14', 'AAHRP 2026-12-14', 'AABPS 2026-12-21', 'AAHRP 2026-12-21']);
  assert.deepEqual([sent[0].kind, sent[0].title, sent[0].body], ['nowplaying', 'Screen Unseen on sale: Mon, Dec 14', 'PG-13 · 2h 9m · Monmouth Mall 15 7:00 PM']);
  assert.deepEqual(sent[0].payload, { now_playing: { theatre: 'AABPS', date: '2026-12-14' } });

  // Nothing new: nothing said, and the theatre already told about is not read again.
  asked.length = 0;
  assert.equal((await alerts.checkUnseens(NOW)).sent, 0);
  assert.equal(asked.includes('AABPS 2026-12-14'), false);

  // It reaches the second theatre later: that is worth a second word.
  listed = { AABPS: true, AAHRP: true };
  assert.equal((await alerts.checkUnseens(NOW)).sent, 1);
  assert.equal(sent[1].body, 'PG-13 · 2h 9m · Brunswick Square 13 7:00 PM');
  assert.deepEqual(Object.keys(db.get('now_playing_alert_state').unseen).sort(), ['2026-12-14|screen|AABPS', '2026-12-14|screen|AAHRP']);
});

test('unseens: nothing is said about one you already hold a ticket for', async () => {
  stubDb();
  const sent = captureNotify();
  nowPlaying.theatresForView = async () => ({ home: HOME, saved: [], visited: [] });
  nowPlaying.flagFilms = async (films) => films.map((f) => ({ ...f, booked: { watch_id: 'w9' } }));
  unseenLookup.upcomingUnseens = async () => [{ date: '2026-12-14', type: 'screen', rating: 'PG-13', runtime: 129 }];
  fandango.showtimes = async (id, date) => ({ date, films: [unseenFilm(['7:00 PM'])] });
  assert.equal((await alerts.checkUnseens(NOW)).sent, 0);
  assert.equal((await alerts.checkUnseens(NOW)).sent, 0);
  assert.equal(sent.length, 0);
});

test('unseens: one whose showings have all started is not announced', async () => {
  stubDb();
  const sent = captureNotify();
  nowPlaying.theatresForView = async () => ({ home: HOME, saved: [], visited: [] });
  nowPlaying.flagFilms = async (films) => films.map((f) => ({ ...f, booked: null }));
  unseenLookup.upcomingUnseens = async () => [{ date: '2026-11-20', type: 'screen', rating: 'PG', runtime: 114 }];
  fandango.showtimes = async (id, date) => ({ date, films: [{ id: 900, title: 'AMC Screen Unseen: November 20', formats: [{ format: 'Standard', notes: [], showtimes: [{ label: '7:00 PM', past: true }] }] }] });
  assert.equal((await alerts.checkUnseens(NOW)).sent, 0);
  assert.equal(sent.length, 0);
});

test('new films: the first look only learns the board, later ones name what has arrived', async () => {
  const db = stubDb();
  const sent = captureNotify();
  nowPlaying.theatresForView = async () => ({ home: HOME, saved: [], visited: [OTHER] });
  let board = { '2026-11-20': [[1, 'Clayface'], [2, 'Wicker']], '2026-11-25': [[1, 'Clayface'], [900, 'AMC Screen Unseen: November 25']] };
  const asked = [];
  fandango.showtimes = async (id, date) => {
    asked.push(`${id} ${date}`);
    return { date, films: (board[date] || []).map(([fid, title]) => ({ id: fid, title, formats: [] })) };
  };

  assert.deepEqual(await alerts.checkNewFilms(NOW), { sent: 0, learned: 2, first_run: true });
  // Fourteen days at the main theatre, and nowhere else.
  assert.equal(asked.length, 14);
  assert.ok(asked.every((a) => a.startsWith('AABPS ')));
  assert.deepEqual([asked[0], asked[13]], ['AABPS 2026-11-20', 'AABPS 2026-12-03']);
  assert.equal(sent.length, 0);

  assert.deepEqual(await alerts.checkNewFilms(NOW), { sent: 0, learned: 0, first_run: false });

  board = { ...board, '2026-11-25': [[1, 'Clayface'], [3, 'Hexed'], [4, 'Hershey']], '2026-11-26': [[5, 'Lilo & Scratch'], [6, 'Steps'], [7, 'Flavia']] };
  assert.equal((await alerts.checkNewFilms(NOW)).sent, 1);
  assert.deepEqual([sent[0].title, sent[0].body], ['New at Monmouth Mall 15', 'Hexed (Nov 25), Hershey (Nov 25), Lilo & Scratch (Nov 26), Steps (Nov 26) and 1 more']);
  assert.deepEqual(sent[0].payload, { now_playing: { theatre: 'AABPS', date: '2026-11-25' } });
  // The Unseen is known, so it is never called a new film.
  assert.ok(db.get('now_playing_alert_state').films.AABPS.includes(900));
  assert.equal((await alerts.checkNewFilms(NOW)).sent, 0);
});

test('new films: a source that cannot be read at all is an error, not an empty board', async () => {
  stubDb();
  captureNotify();
  nowPlaying.theatresForView = async () => ({ home: HOME, saved: [], visited: [] });
  fandango.showtimes = async () => {
    throw new Error('HTTP 503');
  };
  await assert.rejects(alerts.checkNewFilms(NOW), /Could not read any day/);
});
