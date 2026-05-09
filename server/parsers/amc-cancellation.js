// Parse an AMC "A-List Reservation Cancelation" email.
// The order_number in this email matches the original reservation's order_number,
// which is the canonical key for marking the corresponding pending watch as 'cancelled'.
//
// Required for parse_status='ok': order_number.
// Best-effort: title, theater_name, ticket_confirmation, showtime (used only for sanity).
//
// Body anchor (verified):
//   "Order Number: <digits>"
//   "Confirmation #: <digits> Refund Date: MM/DD/YYYY <Title> MM/DD/YYYY HH:MM <AMC Theater> Refunded Tickets"

const { load, clean, bodyText, parseDateThen24Hr } = require('./util');

const REFUND_BLOCK = new RegExp(
  [
    'Confirmation\\s*#:\\s*(?<ticket>\\d+)\\s+',
    'Refund\\s+Date:\\s+\\d{1,2}\\/\\d{1,2}\\/\\d{4}\\s+',
    '(?<title>.+?)\\s+',
    '(?<date>\\d{1,2}\\/\\d{1,2}\\/\\d{4})\\s+',
    '(?<time>\\d{1,2}:\\d{2})\\s+',
    '(?<theater>AMC\\s+[^.\\n]+?)\\s+',
    'Refunded\\s+Tickets',
  ].join(''),
  'i'
);

function parse({ subject, html, text }) {
  const $ = load(html);
  const body = bodyText($) || clean(text || '');

  const orderM = /Order\s+Number:\s*(\d+)/i.exec(body);
  const order_number = orderM ? orderM[1] : null;

  let title = null;
  let theater_name = null;
  let showtime = null;
  let ticket_confirmation = null;

  const block = REFUND_BLOCK.exec(body);
  if (block) {
    ticket_confirmation = block.groups.ticket;
    title = clean(block.groups.title);
    theater_name = clean(block.groups.theater);
    showtime = parseDateThen24Hr(`${block.groups.date} ${block.groups.time}`);
  }

  const ok = !!order_number;
  return {
    ok,
    error: ok ? null : 'missing required field: order_number',
    fields: { order_number, title, theater_name, showtime, ticket_confirmation },
  };
}

module.exports = { parse };
