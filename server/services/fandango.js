// Showtimes and seat maps for the Now Playing tab, read from Fandango's site
// endpoints. AMC's own API needs a vendor key that is only issued under
// contract and its website refuses plain requests, while Fandango sells AMC's
// seats and answers these four read-only GETs without a login. They are
// undocumented, so every shape is normalised here and nothing else in the app
// sees a raw response.

const { fetchWithTimeout } = require('./http');

const ORIGIN = 'https://www.fandango.com';
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0';
const TIMEOUT_MS = 20_000;

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const TTL = {
  search: 24 * HOUR,
  calendar: 6 * HOUR,
  showtimes: 5 * MIN,
  seats: 45 * SEC,
};

const THEATRE_ID = /^[A-Za-z]{5}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHOWTIME_HASH = /^[A-Za-z0-9_-]{8,128}$/;

class FandangoError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = 'FandangoError';
    this.status = status;
  }
}

// ---------- cache ----------

// Holds the promise, not the value, so two people opening the same seat map at
// once share one request. A failed request is dropped rather than remembered.
const cache = new Map();
const MAX_ENTRIES = 400;

function cached(key, ttl, load) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expires > now) return hit.promise;
  const promise = load();
  cache.set(key, { promise, expires: now + ttl });
  promise.catch(() => {
    if (cache.get(key)?.promise === promise) cache.delete(key);
  });
  if (cache.size > MAX_ENTRIES) {
    for (const [k, v] of cache) if (v.expires <= now) cache.delete(k);
    for (const k of cache.keys()) {
      if (cache.size <= MAX_ENTRIES * 0.75) break;
      cache.delete(k);
    }
  }
  return promise;
}

function clearCache() {
  cache.clear();
}

// ---------- transport ----------

// At most this many requests in flight. A page of showtimes can ask for a
// dozen seat counts at once and the endpoint is a favour, not a contract.
const MAX_IN_FLIGHT = 3;
let inFlight = 0;
const waiting = [];

async function limited(fn) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise((resolve) => waiting.push(resolve));
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    const next = waiting.shift();
    if (next) next();
  }
}

async function getJson(path, query = {}) {
  const url = new URL(path, ORIGIN);
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await limited(() =>
    fetchWithTimeout(
      url,
      {
        headers: {
          Accept: 'application/json, text/javascript, */*; q=0.01',
          'Accept-Language': 'en-US,en;q=0.9',
          'X-Requested-With': 'XMLHttpRequest',
          Referer: `${ORIGIN}/`,
          'User-Agent': USER_AGENT,
        },
      },
      TIMEOUT_MS
    )
  );
  if (res.status === 404) throw new FandangoError('Not found', 404);
  if (!res.ok) throw new FandangoError(`Showtimes source returned HTTP ${res.status}`);
  try {
    return await res.json();
  } catch {
    throw new FandangoError('Showtimes source sent something that is not JSON');
  }
}

// ---------- theatres ----------

function shapeTheatre(t) {
  return {
    id: t.id,
    name: t.name,
    address: t.address1 || null,
    city: t.city || null,
    state: t.state || null,
    zip: t.zip || null,
    distance_miles: typeof t.distance === 'number' ? Math.round(t.distance * 10) / 10 : null,
  };
}

// "78701" or "Austin, TX". Anything else is not a place the source can search.
function parsePlace(q) {
  const s = String(q || '').trim();
  if (/^\d{5}$/.test(s)) return { zipCode: s };
  const m = s.match(/^([A-Za-z .'-]{2,40}),\s*([A-Za-z]{2})$/);
  if (m) return { zipCode: '', city: m[1].trim(), state: m[2].toUpperCase() };
  return null;
}

function normalizeTheatres(raw) {
  const list = Array.isArray(raw && raw.theaters) ? raw.theaters : [];
  return list.filter((t) => t && t.chainCode === 'AMC' && THEATRE_ID.test(t.id || '')).map(shapeTheatre);
}

async function searchTheatres(q) {
  const place = parsePlace(q);
  if (!place) throw new FandangoError('Enter a ZIP code, or a city and state like Austin, TX', 400);
  const key = `search:${JSON.stringify(place).toLowerCase()}`;
  return cached(key, TTL.search, async () =>
    normalizeTheatres(
      await getJson('/napi/theaterswithshowtimes', {
        ...place,
        chainCode: 'AMC',
        limit: 25,
        page: 1,
        isdesktop: true,
      })
    )
  );
}

// ---------- showtimes ----------

// Amenities that say which screen a showing is on. Everything else an amenity
// group lists is either true of every showing (reserved seating, captions on
// request) or a detail for the notes line.
const SCREEN = [
  [/imax.*70\s*mm/i, 'IMAX 70mm'],
  [/imax/i, 'IMAX'],
  [/dolby cinema/i, 'Dolby Cinema'],
  [/prime/i, 'PRIME'],
  [/\bxl\b/i, 'XL'],
  [/screenx/i, 'ScreenX'],
  [/4dx/i, '4DX'],
  [/70\s*mm/i, '70mm'],
  [/35\s*mm/i, '35mm'],
];
const NOTE = /language|subtitle|open caption|dubbed|sensory|fathom/i;

function describeGroup(header, amenities) {
  const names = amenities.map((a) => (a && a.name) || '').filter(Boolean);
  const parts = [];
  for (const [re, label] of SCREEN) {
    if (names.some((n) => re.test(n)) && !parts.some((p) => p.includes(label))) parts.push(label);
  }
  if (names.some((n) => /\b3d\b/i.test(n))) parts.push('3D');
  const notes = names
    .filter((n) => NOTE.test(n))
    .map((n) => n.replace(/\s+Language$/i, ''));
  return { format: parts.join(' ') || (header === '3D' ? '3D' : 'Standard'), notes };
}

// "2026-11-12+19:15" is the theatre's own clock. Kept as a zoneless local time
// because a showtime means the same thing wherever the phone happens to be.
function localStart(ticketingDate) {
  const m = /^(\d{4}-\d{2}-\d{2})\+(\d{2}:\d{2})$/.exec(ticketingDate || '');
  return m ? `${m[1]}T${m[2]}` : null;
}

// The source's own label says "6 o'clock PM" for a showing on the hour.
function clockLabel(startsAt) {
  const [h, m] = startsAt.slice(11).split(':').map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

function posterOf(movie) {
  const p = movie.poster;
  if (!p || !p.uri || /default_poster\.png$/.test(p.uri)) return null;
  return (p.size && (p.size['300'] || p.size['400'] || p.size.full)) || null;
}

// The source writes PG13 for some films and PG-13 for others.
function ratingOf(raw) {
  const r = String(raw || '').trim();
  if (!r || /^not rated$/i.test(r) || /^nr$/i.test(r)) return null;
  return r.replace(/^(PG|NC)-?(\d+)$/i, (_, a, b) => `${a.toUpperCase()}-${b}`);
}

function splitTitle(raw) {
  const m = /^(.*\S)\s+\((\d{4})\)$/.exec(String(raw || '').trim());
  return m ? { title: m[1], year: Number(m[2]) } : { title: String(raw || '').trim(), year: null };
}

const FORMAT_ORDER = ['IMAX', 'Dolby', 'PRIME', 'XL', 'ScreenX', '4DX', '70mm', '35mm', '3D', 'Standard'];
const formatRank = (f) => {
  const i = FORMAT_ORDER.findIndex((p) => f.startsWith(p));
  return i === -1 ? FORMAT_ORDER.length : i;
};

function normalizeShowtimes(raw) {
  const vm = raw && raw.viewModel;
  if (!vm || !Array.isArray(vm.movies)) {
    if (raw && raw.error) throw new FandangoError('That theatre was not found', 404);
    throw new FandangoError('Showtimes came back in a shape this version does not know');
  }
  const films = [];
  for (const movie of vm.movies) {
    const groups = new Map();
    for (const variant of movie.variants || []) {
      for (const ag of variant.amenityGroups || []) {
        const { format, notes } = describeGroup(variant.filmFormatHeader, ag.amenities || []);
        const key = `${format}|${notes.join(',')}`;
        if (!groups.has(key)) groups.set(key, { format, notes, showtimes: [] });
        for (const s of ag.showtimes || []) {
          const starts_at = localStart(s.ticketingDate);
          if (!starts_at) continue;
          groups.get(key).showtimes.push({
            hash: SHOWTIME_HASH.test(s.showtimeHashCode || '') ? s.showtimeHashCode : null,
            starts_at,
            label: clockLabel(starts_at),
            past: Boolean(s.expired),
            sold_out: Boolean(s.isSoldOut),
            reserved: Boolean(ag.hasReservedSeating),
          });
        }
      }
    }
    const formats = [...groups.values()]
      .filter((g) => g.showtimes.length)
      .map((g) => ({ ...g, showtimes: g.showtimes.sort((a, b) => a.starts_at.localeCompare(b.starts_at)) }))
      .sort((a, b) => formatRank(a.format) - formatRank(b.format) || a.notes.length - b.notes.length);
    if (!formats.length) continue;
    const { title, year } = splitTitle(movie.title);
    films.push({
      id: movie.id,
      title,
      year,
      rating: ratingOf(movie.rating),
      runtime: movie.runtime || null,
      genres: Array.isArray(movie.genres) ? movie.genres.slice(0, 3) : [],
      poster_url: posterOf(movie),
      formats,
    });
  }
  return { date: vm.date || null, films };
}

function normalizeCalendar(raw) {
  const dates = Array.isArray(raw && raw.showtimeDates) ? raw.showtimeDates.filter((d) => DATE.test(d)) : [];
  return { dates, first: (raw && raw.firstShowtime) || dates[0] || null };
}

function assertTheatre(id) {
  if (!THEATRE_ID.test(String(id || ''))) throw new FandangoError('Unknown theatre', 400);
  return String(id).toUpperCase();
}

async function showtimes(theatreId, date) {
  const id = assertTheatre(theatreId);
  if (date && !DATE.test(date)) throw new FandangoError('Date must be YYYY-MM-DD', 400);
  return cached(`showtimes:${id}:${date || ''}`, TTL.showtimes, async () =>
    normalizeShowtimes(
      await getJson(`/napi/theaterMovieShowtimes/${id}`, {
        chainCode: 'AMC',
        startDate: date || undefined,
        isdesktop: true,
        partnerRestrictedTicketing: '',
      })
    )
  );
}

async function calendar(theatreId) {
  const id = assertTheatre(theatreId);
  return cached(`calendar:${id}`, TTL.calendar, async () =>
    normalizeCalendar(await getJson(`/napi/theaterCalendar/${id}`))
  );
}

// ---------- seat maps ----------

// A is open, R is taken. O is what an unsold wheelchair space carries, and the
// source counts it as available, so it is open here too.
const OPEN = new Set(['A', 'O']);

function normalizeSeatMap(raw) {
  if (!raw || !Array.isArray(raw.seats)) {
    throw new FandangoError('The seat map came back in a shape this version does not know');
  }
  const seats = raw.seats
    .filter((s) => s && Number.isFinite(s.x) && Number.isFinite(s.y))
    .map((s) => ({
      id: String(s.id || ''),
      row: (/^[A-Za-z]+/.exec(String(s.id || '')) || [''])[0].toUpperCase(),
      x: s.x,
      y: s.y,
      w: s.width || 40,
      h: s.height || 40,
      kind: s.type === 'wheelchair' || s.type === 'companion' ? s.type : 'standard',
      open: OPEN.has(s.status),
    }));
  const width = Math.max(raw.totalWidth || 0, ...seats.map((s) => s.x + s.w), 1);
  const height = Math.max(raw.totalHeight || 0, ...seats.map((s) => s.y + s.h), 1);
  const available =
    typeof raw.totalAvailableSeatCount === 'number'
      ? raw.totalAvailableSeatCount
      : seats.filter((s) => s.open).length;
  const total = typeof raw.totalSeatCount === 'number' ? raw.totalSeatCount : seats.length;

  const prices = [];
  for (const area of raw.areas || []) {
    for (const t of area.ticketInfo || []) {
      const price = Number(t.price);
      if (t.desc && Number.isFinite(price) && !prices.some((p) => p.label === t.desc)) {
        prices.push({ label: t.desc, price });
      }
    }
  }

  return {
    theatre: raw.theaterName || null,
    auditorium: raw.auditoriumId != null ? String(raw.auditoriumId) : null,
    available,
    total,
    width,
    height,
    seats,
    prices,
    fetched_at: new Date().toISOString(),
  };
}

function assertHash(hash) {
  if (!SHOWTIME_HASH.test(String(hash || ''))) throw new FandangoError('Unknown showtime', 400);
  return String(hash);
}

async function seatMap(hash) {
  const h = assertHash(hash);
  return cached(`seats:${h}`, TTL.seats, async () => {
    try {
      return normalizeSeatMap(await getJson(`/napi/seatMap/${h}`));
    } catch (err) {
      if (err.status === 404) throw new FandangoError('That showing is no longer on sale', 404);
      throw err;
    }
  });
}

// Open and total seats for several showings. A showing that fails is left out
// rather than failing the batch: one sold-through show should not blank a row.
async function seatCounts(hashes) {
  const out = {};
  await Promise.all(
    hashes.map(async (hash) => {
      try {
        const m = await seatMap(hash);
        out[hash] = { available: m.available, total: m.total };
      } catch {
        /* left out on purpose */
      }
    })
  );
  return out;
}

module.exports = {
  searchTheatres,
  showtimes,
  calendar,
  seatMap,
  seatCounts,
  clearCache,
  FandangoError,
  THEATRE_ID,
  SHOWTIME_HASH,
  _internal: {
    parsePlace,
    describeGroup,
    localStart,
    splitTitle,
    normalizeTheatres,
    normalizeShowtimes,
    normalizeCalendar,
    normalizeSeatMap,
  },
};
