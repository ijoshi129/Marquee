// Parse an AMC reservation/order confirmation email.
// Required for parse_status='ok': title, theater_name, showtime, order_number.
//
// Anchors used (verified against real AMC samples):
//   - "Ticket Confirmation#: <digits> <Title> <H:MM AM|PM> <M/D/YYYY> <AMC Theater> The listed showtime"
//   - "Order Number: <digits>"
//   - "Auditorium: <num>"

const { load, clean, bodyText, parseTimeThenDate } = require('./util');
const { extractTags, extractFormatsFromHtml } = require('../utils/normalize');

// Anchor on the structured row sequence AMC uses in reservation emails. Both the
// 2022-era format ("Ticket Purchase Details") and the modern format ("Your Ticket
// Reservation Details") emit the same sub-block:
//   Ticket Confirmation#: <num>
//   <Title>
//   <H:MM AM|PM> <M/D/YYYY>
//   <AMC Theater>
// followed by either "The listed showtime is when..." (modern), "This showing
// will start promptly..." (screenings with no trailers) or "Auditorium:"
// (older). The end anchor allows for any of them, plus end-of-input as a
// fallback.
const RESERVATION_BLOCK = new RegExp(
  [
    'Ticket\\s+Confirmation#?:\\s*(?<ticket>\\d+)\\s+',
    '(?<title>.+?)\\s+',
    '(?<time>\\d{1,2}:\\d{2}\\s*[AP]M)\\s+',
    '(?<date>\\d{1,2}\\/\\d{1,2}\\/\\d{4})\\s+',
    '(?<theater>AMC\\s+.+?)',
    '\\s+(?:The\\s+listed\\s+showtime|This\\s+showing\\s+will|Auditorium:|Reserved\\s+Seats|Photo\\s+ID|$)',
  ].join(''),
  'i'
);

function parse({ subject, html, text }) {
  const $ = load(html);
  const body = bodyText($) || clean(text || '');

  // Several non-ticket order types share the "Order Number" subject pattern (concessions,
  // A-List membership renewal, AMC Popcorn Pass). Skip silently when there's no ticket
  // block in the body — the reservation parser only cares about movie tickets.
  if (!/Ticket\s+(?:Purchase|Reservation)\s+Details/i.test(body)) {
    let reason = 'non-ticket order';
    if (/Food\s+and\s+Drink\s+Purchase\s+Details/i.test(body)) reason = 'concession order';
    else if (/A-List/i.test(body) && /Membership\s+Total/i.test(body)) reason = 'A-List membership receipt';
    else if (/Popcorn\s+Pass/i.test(body)) reason = 'AMC Popcorn Pass';
    return { ok: true, skip: true, reason, fields: null };
  }

  const block = RESERVATION_BLOCK.exec(body);
  let title = null;
  let theater_name = null;
  let showtime = null;
  let ticket_confirmation = null;

  if (block) {
    ticket_confirmation = block.groups.ticket;
    title = clean(block.groups.title);
    theater_name = clean(block.groups.theater);
    showtime = parseTimeThenDate(`${block.groups.time} ${block.groups.date}`);
  }

  const orderM = /Order\s+Number:\s*(\d+)/i.exec(body);
  const order_number = orderM ? orderM[1] : null;

  // Where to sit. "Reserved Seats: G8" or "F8, F9"; a wheelchair space is "WC1".
  const audM = /Auditorium:\s*([A-Za-z0-9]{1,6})\b/i.exec(body);
  const auditorium = audM ? audM[1] : null;
  const seatsM = /Reserved\s+Seats?:\s*([A-Z]{1,2}\d{1,3}(?:\s*,\s*[A-Z]{1,2}\d{1,3})*)/.exec(body);
  const seats = seatsM ? seatsM[1].split(',').map((s) => s.trim()) : [];
  // "Ticket: 1 Adult; $7.25" or "2 Adult; $14.50 1 Child; $6.00". General
  // admission has no seats to count, so the ticket lines are the fallback.
  const ticketsM = /\bTicket:\s*(.+?)\s+(?:Ticket\s+Total|\d+\s+[^;$]*?Savings)/i.exec(body);
  const priced = ticketsM ? [...ticketsM[1].matchAll(/(\d+)\s+[A-Za-z][A-Za-z -]*;\s*\$/g)] : [];
  const ticket_count = seats.length || priced.reduce((n, m) => n + Number(m[1]), 0) || null;

  // Format tags: titles sometimes carry trailing suffixes (e.g. "in RealD 3D"),
  // and HTML bodies sometimes carry <img alt="..."> badges for the format.
  // Merge both sources, dedup.
  const tags = [...new Set([...extractTags(title), ...extractFormatsFromHtml(html)])];

  const ok = !!(title && theater_name && showtime && order_number);
  const fields = {
    title,
    theater_name,
    showtime,
    order_number,
    ticket_confirmation,
    tags,
    auditorium,
    seats,
    ticket_count,
  };

  return {
    ok,
    error: ok ? null : missingFieldsError({ title, theater_name, showtime, order_number }),
    fields,
  };
}

function missingFieldsError(req) {
  const missing = Object.entries(req).filter(([, v]) => !v).map(([k]) => k);
  return `missing required fields: ${missing.join(', ')}`;
}

module.exports = { parse };
