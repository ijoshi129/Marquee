const cheerio = require('cheerio');

function load(html) {
  return cheerio.load(html || '', { decodeEntities: true });
}

// Cleaned, single-line body text. Strips zero-width chars and collapses whitespace.
function bodyText($) {
  const raw = $('body').length ? $('body').text() : $.root().text();
  return clean(raw);
}

function clean(s) {
  if (!s) return '';
  return s
    .replace(/[​-‍﻿]/g, '') // zero-width
    .replace(/ /g, ' ') // nbsp
    .replace(/\s+/g, ' ')
    .trim();
}

// Parse "7:00 PM 5/4/2026" → ISO. Returns null if no match.
function parseTimeThenDate(text) {
  if (!text) return null;
  const m = /(\d{1,2}):(\d{2})\s*(AM|PM)\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  if (m[3].toUpperCase() === 'PM' && hour < 12) hour += 12;
  if (m[3].toUpperCase() === 'AM' && hour === 12) hour = 0;
  const month = parseInt(m[4], 10) - 1;
  const day = parseInt(m[5], 10);
  const year = parseInt(m[6], 10);
  const d = new Date(Date.UTC(year, month, day, hour, minute));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// Parse "05/05/2026 19:30" (24-hr, date-first) → ISO.
function parseDateThen24Hr(text) {
  if (!text) return null;
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})\b/.exec(text);
  if (!m) return null;
  const month = parseInt(m[1], 10) - 1;
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  const hour = parseInt(m[4], 10);
  const minute = parseInt(m[5], 10);
  const d = new Date(Date.UTC(year, month, day, hour, minute));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

module.exports = { load, clean, bodyText, parseTimeThenDate, parseDateThen24Hr };
