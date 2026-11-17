const APP_TIME_ZONE = process.env.APP_TIMEZONE || process.env.TZ || 'America/New_York';

// Showtimes are stored as the printed wall-clock time labelled UTC, so the
// stored instant isn't real. Reinterpret those wall-clock parts in the owner's
// timezone to recover the true instant (DST handled by Intl).
function realShowtimeMs(showtime, timeZone = APP_TIME_ZONE) {
  const wallAsUtc = new Date(showtime).getTime();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
    .formatToParts(new Date(wallAsUtc))
    .reduce((a, p) => ((a[p.type] = p.value), a), {});
  const shown = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return wallAsUtc - (shown - wallAsUtc);
}

// "7:00 PM" from a stored showtime, or from one moved by some minutes.
function clockLabel(showtime, plusMinutes = 0) {
  const d = new Date(new Date(showtime).getTime() + plusMinutes * 60000);
  const h = d.getUTCHours();
  return `${h % 12 || 12}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

// Today's date where the owner is, as YYYY-MM-DD.
function localDate(now = Date.now(), timeZone = APP_TIME_ZONE) {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date(now));
}

module.exports = { APP_TIME_ZONE, realShowtimeMs, clockLabel, localDate };
