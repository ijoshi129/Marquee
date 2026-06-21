export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const MONTH_NAMES_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// A booked showtime → 'Jun 28 · 7:30 PM'. Showtimes are stored as the local
// screening time labelled UTC, so format in UTC to echo what was booked rather
// than shifting it into the browser's timezone.
export function fmtShowtime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const date = d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  const time = d.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'UTC',
  });
  return `${date} · ${time}`;
}

// 'YYYY-MM-DD' → 'Jul 18', adding the year only when it isn't the current one.
export function fmtShortDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const base = `${MONTH_NAMES[m - 1]} ${d}`;
  return y === new Date().getFullYear() ? base : `${base}, ${y}`;
}

// An Unseen's actual title stays hidden until the owner has seen the film —
// revealing it earlier (in the diary or as an "Identify?" prompt) spoils the
// mystery screening. Reveal 2h after the showtime, roughly when the film lets
// out. Showtimes are stored as wall-clock parts labelled UTC; rebuild them in
// the browser's local zone (the owner's timezone) for the true instant, so the
// gate tracks the real showtime instead of a padded guess. Mirrors the server
// gate in tmdb-rechecker.
const UNSEEN_REVEAL_AFTER_MS = 2 * 60 * 60 * 1000;
export function unseenRevealed(showtime) {
  if (!showtime) return true;
  const d = new Date(showtime);
  const real = new Date(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate(),
    d.getUTCHours(),
    d.getUTCMinutes()
  ).getTime();
  return Date.now() >= real + UNSEEN_REVEAL_AFTER_MS;
}

// True when an 'YYYY-MM-DD' release date is still in the future.
export function isUpcoming(iso) {
  if (!iso) return false;
  const today = new Date().toISOString().slice(0, 10);
  return iso.slice(0, 10) > today;
}

export function fmtRuntime(mins) {
  if (!mins) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

export function fmtMoney(n) {
  if (n == null) return '—';
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function ordinal(n) {
  const mod100 = n % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

// The "Nth watch" badge for a rewatch, or null for a first/only watch or a
// row that isn't a confirmed watch.
export function rewatchLabel(w) {
  if (!w || w.status !== 'watched') return null;
  if (!(w.rewatch_total >= 2) || !(w.rewatch_ordinal >= 2)) return null;
  return `${ordinal(w.rewatch_ordinal)} watch`;
}

// Mirror of RERELEASE_SUFFIX in server/utils/normalize.js — keep in sync.
const RERELEASE_RE =
  /[\s:–—-]+(?:\d{1,3}(?:st|nd|rd|th)\s+anniversary|anniversary\s+edition|re-?release|re-?issue)(?:\s+(?:edition|re-?release|presentation|event|in\s+cinemas))?\s*$/i;

// TMDB's cleaner name in general, but the watch's own title when it's a
// re-release so "Top Gun 40th Anniversary" isn't flattened to "Top Gun".
export function watchDisplayTitle(w) {
  if (!w) return '';
  if (w.title && RERELEASE_RE.test(w.title)) return w.title;
  return w.tmdb?.title || w.title;
}
