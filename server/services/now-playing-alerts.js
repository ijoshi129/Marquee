// Three things Now Playing can tell the owner without being asked:
//   - an upcoming Unseen has gone on sale at one of their theatres
//   - new films have appeared at their main theatre
//   - a showing they chose to watch is filling up, or has sold out
//
// All three read the same showtimes source as the tab itself, at a pace a
// person browsing would not exceed.

const { pool } = require('../db');
const logger = require('../logger');
const fandango = require('./fandango');
const nowPlaying = require('./now-playing');
const notifications = require('./notifications');
const unseenLookup = require('./unseen-lookup');
const { realShowtimeMs, localDate } = require('../utils/showtime');

const DAY = 24 * 60 * 60 * 1000;
const WATCHING_KEY = 'now_playing_watching';
const STATE_KEY = 'now_playing_alert_state';
const MAX_WATCHING = 12;
const MAX_THEATRES = 4;
const NEW_FILM_DAYS = 14;
const MAX_KNOWN_FILMS = 600;
// "Filling up" once this share of the seats is all that is left.
const LOW_SHARE = 0.25;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(iso) {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}, ${MONTHS[m - 1]} ${d}`;
}
const fmtRuntime = (mins) => `${Math.floor(mins / 60)}h ${mins % 60}m`;
const shortName = (name) => String(name || '').replace(/^AMC\s+/i, '');
const addDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

async function readJson(key, fallback) {
  const { rows } = await pool.query('SELECT value FROM app_state WHERE key = $1', [key]);
  if (!rows[0]) return fallback;
  try {
    return JSON.parse(rows[0].value);
  } catch {
    return fallback;
  }
}

async function writeJson(key, value) {
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

// Home first, then the diary's theatres by visits, then any others saved.
async function theatres() {
  const view = await nowPlaying.theatresForView();
  const out = [];
  for (const t of [view.home, ...(view.visited || []), ...view.saved]) {
    if (t && !out.some((o) => o.id === t.id)) out.push(t);
  }
  return out.slice(0, MAX_THEATRES);
}

// ---------- showings being watched ----------

function cleanWatch(input) {
  if (!input || !fandango.SHOWTIME_HASH.test(String(input.hash || ''))) return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(String(input.starts_at || ''))) return null;
  const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  const title = text(input.title, 200);
  if (!title) return null;
  return {
    hash: String(input.hash),
    title,
    starts_at: input.starts_at,
    label: text(input.label, 20),
    format: text(input.format, 40),
    theatre_id: fandango.THEATRE_ID.test(String(input.theatre_id || '')) ? String(input.theatre_id).toUpperCase() : null,
    theatre_name: text(input.theatre_name, 120),
    notified_low: Boolean(input.notified_low),
    notified_full: Boolean(input.notified_full),
  };
}

const hasStarted = (w, now) => realShowtimeMs(`${w.starts_at}:00.000Z`) <= now;

async function listWatching(now = Date.now()) {
  const raw = await readJson(WATCHING_KEY, []);
  return (Array.isArray(raw) ? raw : []).map(cleanWatch).filter((w) => w && !hasStarted(w, now));
}

async function watchShowing(input) {
  const w = cleanWatch({ ...input, notified_low: false, notified_full: false });
  if (!w) return null;
  const list = (await listWatching()).filter((x) => x.hash !== w.hash);
  list.push(w);
  await writeJson(WATCHING_KEY, list.slice(-MAX_WATCHING));
  return w;
}

async function unwatchShowing(hash) {
  const list = await listWatching();
  await writeJson(WATCHING_KEY, list.filter((x) => x.hash !== hash));
}

function seatsAlert(w, seats) {
  const where = [shortName(w.theatre_name), w.format && w.format !== 'Standard' ? w.format : null].filter(Boolean).join(', ');
  const when = `${dayLabel(w.starts_at)}${w.label ? ` ${w.label}` : ''}`;
  const payload = { now_playing: { theatre: w.theatre_id, date: w.starts_at.slice(0, 10) } };
  if (seats.available <= 0) {
    if (w.notified_full) return null;
    return { flag: 'notified_full', kind: 'nowplaying', title: `Sold out: ${w.title}`, body: [when, where].filter(Boolean).join(' · '), payload, dedupeKey: `watching:${w.hash}:full` };
  }
  if (seats.total > 0 && seats.available / seats.total <= LOW_SHARE) {
    if (w.notified_low) return null;
    return {
      flag: 'notified_low',
      kind: 'nowplaying',
      title: `Filling up: ${w.title}`,
      body: `${seats.available} of ${seats.total} seats left · ${[when, where].filter(Boolean).join(' · ')}`,
      payload,
      dedupeKey: `watching:${w.hash}:low`,
    };
  }
  return null;
}

async function checkWatching(now = Date.now()) {
  const list = await listWatching(now);
  const keep = [];
  let sent = 0;
  let failed = null;
  for (const w of list) {
    let seats;
    try {
      seats = await fandango.seatMap(w.hash);
    } catch (err) {
      // Off sale: nothing left to watch. Anything else: try again next pass.
      if (err.status !== 404) {
        failed = err;
        keep.push(w);
      }
      continue;
    }
    const alert = seatsAlert(w, seats);
    if (alert) {
      const { flag, ...notification } = alert;
      if (await notifications.notify(notification)) sent += 1;
      w[flag] = true;
      // Sold out says everything "filling up" would have.
      if (flag === 'notified_full') w.notified_low = true;
    }
    keep.push(w);
  }
  if (keep.length !== list.length || sent) await writeJson(WATCHING_KEY, keep);
  return { watching: keep.length, sent, error: failed };
}

// ---------- an Unseen going on sale ----------

async function checkUnseens(now = Date.now()) {
  const today = localDate(now);
  const upcoming = (await unseenLookup.upcomingUnseens()).filter((u) => u.date >= today);
  if (!upcoming.length) return { upcoming: 0, sent: 0 };
  const where = await theatres();
  if (!where.length) return { upcoming: upcoming.length, sent: 0 };

  const state = await readJson(STATE_KEY, {});
  const told = state.unseen || {};
  let sent = 0;
  for (const u of upcoming) {
    const found = [];
    let booked = false;
    for (const t of where) {
      const key = `${u.date}|${u.type}|${t.id}`;
      if (told[key]) continue;
      let board;
      try {
        board = await fandango.showtimes(t.id, u.date);
      } catch (err) {
        logger.warn(`now-playing-alerts: could not read ${t.name} for ${u.date}: ${err.message}`);
        continue;
      }
      const films = await nowPlaying.flagFilms(board.films.filter((f) => nowPlaying.unseenKind(f.title) === u.type));
      if (!films.length) continue;
      told[key] = true;
      if (films.some((f) => f.booked)) booked = true;
      const times = films.flatMap((f) => f.formats.flatMap((g) => g.showtimes)).filter((s) => !s.past);
      // Listed, but every showing has started: too late to be news.
      if (!times.length) continue;
      found.push({ theatre: t, times: times.map((s) => s.label) });
    }
    // Already holding a ticket: there is nothing to tell.
    if (!found.length || booked) continue;
    const kind = u.type === 'scream' ? 'Scream Unseen' : 'Screen Unseen';
    const clues = [u.rating, u.runtime ? fmtRuntime(u.runtime) : null].filter(Boolean).join(' · ');
    // A push shows a line or two, so name the main theatre and count the rest.
    const [first, ...rest] = found;
    const places = `${shortName(first.theatre.name)} ${first.times.slice(0, 2).join(', ')}${rest.length ? ` and ${rest.length} more` : ''}`;
    const row = await notifications.notify({
      kind: 'nowplaying',
      title: `${kind} on sale: ${dayLabel(u.date)}`,
      body: [clues, places].filter(Boolean).join(' · '),
      payload: { now_playing: { theatre: found[0].theatre.id, date: u.date } },
      dedupeKey: `unseen-listed:${u.date}:${u.type}:${found.map((f) => f.theatre.id).sort().join(',')}`,
    });
    if (row) sent += 1;
  }
  // Forget screenings that have passed, so the record does not grow for ever.
  for (const key of Object.keys(told)) if (key.slice(0, 10) < today) delete told[key];
  await writeJson(STATE_KEY, { ...(await readJson(STATE_KEY, {})), unseen: told });
  return { upcoming: upcoming.length, sent };
}

// ---------- new films at the main theatre ----------

async function checkNewFilms(now = Date.now()) {
  const [theatre] = await theatres();
  if (!theatre) return { sent: 0 };
  const today = localDate(now);
  const state = await readJson(STATE_KEY, {});
  const films = state.films || {};
  const known = new Set(films[theatre.id] || []);
  const firstRun = !films[theatre.id];

  const fresh = new Map();
  let read = 0;
  for (let i = 0; i < NEW_FILM_DAYS; i++) {
    const date = addDays(today, i);
    let board;
    try {
      board = await fandango.showtimes(theatre.id, date);
    } catch (err) {
      logger.warn(`now-playing-alerts: could not read ${theatre.name} for ${date}: ${err.message}`);
      continue;
    }
    read += 1;
    for (const f of board.films) {
      if (known.has(f.id) || fresh.has(f.id)) continue;
      // An Unseen has its own alert, with more to say.
      if (nowPlaying.unseenKind(f.title)) {
        known.add(f.id);
        continue;
      }
      fresh.set(f.id, { title: f.title, date });
    }
  }
  if (!read) throw new Error(`Could not read any day at ${theatre.name}`);

  for (const id of fresh.keys()) known.add(id);
  films[theatre.id] = [...known].slice(-MAX_KNOWN_FILMS);
  await writeJson(STATE_KEY, { ...(await readJson(STATE_KEY, {})), films });

  // The first look at a theatre only learns what is there: everything is new.
  if (firstRun || !fresh.size) return { sent: 0, learned: fresh.size, first_run: firstRun };

  const list = [...fresh.values()];
  const named = list.slice(0, 4).map((f) => `${f.title} (${dayLabel(f.date).split(', ')[1]})`);
  const more = list.length - named.length;
  const row = await notifications.notify({
    kind: 'nowplaying',
    title: `New at ${shortName(theatre.name)}`,
    body: `${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}`,
    payload: { now_playing: { theatre: theatre.id, date: list[0].date } },
    dedupeKey: `new-films:${theatre.id}:${today}`,
  });
  return { sent: row ? 1 : 0, learned: fresh.size, first_run: false };
}

module.exports = {
  listWatching,
  watchShowing,
  unwatchShowing,
  checkWatching,
  checkUnseens,
  checkNewFilms,
  _internal: { seatsAlert, cleanWatch, dayLabel, WATCHING_KEY, STATE_KEY },
};
