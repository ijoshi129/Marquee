export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export const MONTH_NAMES_LONG = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

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
