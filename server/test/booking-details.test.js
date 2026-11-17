const assert = require('node:assert/strict');
const { test } = require('./harness');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const reservation = require('../parsers/amc-reservation');
const { realShowtimeMs, clockLabel, localDate } = require('../utils/showtime');

// The wording of real AMC reservation emails, with the names and numbers
// replaced. Each line is its own element, as in the emails.
const email = (lines) => `<html><body>${lines.map((l) => `<p>${l}</p> `).join('')}</body></html>`;
const HEAD = ['Order Number: 987654321', 'Date: 11/13/2026', 'Total Amount: $0.00', 'Your Ticket Reservation Details', 'Ticket Confirmation#: 123456789'];
const TAIL = ['Waived Convenience Fee: $2.69', 'Pre-Order Concessions', 'AMC Monmouth Mall 15', '180 Rt 35', 'Eatontown, NJ 07724'];

const parse = (lines) => reservation.parse({ subject: 'Your AMC Entourage Order Number 987654321 from 11/13/2026', html: email(lines), text: '' });

test('reservation: the auditorium, seat and ticket count are read', () => {
  const r = parse([
    ...HEAD,
    'AMC Screen Unseen: November 16',
    '7:00 PM 11/16/2026',
    'AMC Monmouth Mall 15',
    'The listed showtime is when trailers and additional content begin. The movie will start 25-30 minutes after the listed showtime.',
    'Jane Doe',
    'Photo ID Required',
    'Auditorium: 1',
    'Reserved Seats: G8',
    'Everyone in your Entourage will receive a reservation email with their seat number.',
    'Ticket: 1 Adult; $7.25',
    '1 AMC Stubs A-List Savings: -$7.25',
    'Ticket Total: $0.00',
    ...TAIL,
  ]);
  assert.equal(r.ok, true);
  assert.deepEqual(
    { theatre: r.fields.theater_name, auditorium: r.fields.auditorium, seats: r.fields.seats, tickets: r.fields.ticket_count },
    { theatre: 'AMC Monmouth Mall 15', auditorium: '1', seats: ['G8'], tickets: 1 }
  );
});

test('reservation: several seats on one order', () => {
  const r = parse([
    ...HEAD,
    'The Odyssey',
    '10:00 PM 7/21/2026',
    'AMC New Brunswick 18',
    'The listed showtime is when trailers and additional content begin.',
    'Auditorium: 17',
    'Reserved Seats: R23, R24, WC1',
    'Ticket: 2 Adult; $39.98',
    '1 Child; $12.00',
    '1 Tue and Wed Savings: -$7.25',
    'Ticket Total: $44.73',
    ...TAIL,
  ]);
  assert.deepEqual([r.fields.auditorium, r.fields.seats, r.fields.ticket_count], ['17', ['R23', 'R24', 'WC1'], 3]);
});

test('reservation: with no seats listed the ticket lines give the count', () => {
  const r = parse([
    ...HEAD,
    'A Film',
    '1:00 PM 7/21/2026',
    'AMC Freehold 14',
    'The listed showtime is when trailers and additional content begin.',
    'Auditorium: 4',
    'Ticket: 2 Adult; $20.00',
    '1 Senior; $8.00',
    'Ticket Total: $28.00',
    ...TAIL,
  ]);
  assert.deepEqual([r.fields.seats, r.fields.ticket_count], [[], 3]);
});

test('reservation: an older email with none of it still parses', () => {
  const r = parse([...HEAD, 'A Film', '1:00 PM 7/21/2026', 'AMC Freehold 14', 'Photo ID Required', ...TAIL]);
  assert.equal(r.ok, true);
  assert.deepEqual([r.fields.auditorium, r.fields.seats, r.fields.ticket_count], [null, [], null]);
});

test('reservation: a no-trailers notice is not taken as part of the theatre name', () => {
  const r = parse([
    ...HEAD,
    'Wicked: For Good',
    '7:00 PM 12/15/2026',
    'AMC New Brunswick 18',
    'This showing will start promptly at its scheduled showtime, with little or no trailers or other content before it begins. Please arrive on time so you don’t miss the show.',
    'Jane Doe',
    'Photo ID Required',
    'Auditorium: 17',
    'Reserved Seats: K12',
    'Ticket: 1 Adult; $19.99',
    '1 AMC Stubs A-List Savings: -$19.99',
    'Ticket Total: $0.00',
    ...TAIL,
  ]);
  assert.equal(r.fields.theater_name, 'AMC New Brunswick 18');
  assert.deepEqual([r.fields.auditorium, r.fields.seats], ['17', ['K12']]);
});

test('showtime clock: the stored wall-clock time becomes the real instant where the owner is', () => {
  // 7:00 PM printed on a ticket in New Jersey, in winter and in summer.
  assert.equal(new Date(realShowtimeMs('2026-11-16T19:00:00.000Z', 'America/New_York')).toISOString(), '2026-11-17T00:00:00.000Z');
  assert.equal(new Date(realShowtimeMs('2026-07-21T19:00:00.000Z', 'America/New_York')).toISOString(), '2026-07-21T23:00:00.000Z');
  assert.equal(new Date(realShowtimeMs('2026-11-16T19:00:00.000Z', 'America/Los_Angeles')).toISOString(), '2026-11-17T03:00:00.000Z');
  assert.equal(clockLabel('2026-11-16T19:00:00.000Z'), '7:00 PM');
  assert.equal(clockLabel('2026-11-16T19:00:00.000Z', 25 + 118), '9:23 PM');
  assert.equal(clockLabel('2026-11-16T00:05:00.000Z'), '12:05 AM');
  // 03:30 UTC is still the evening before in New Jersey.
  assert.equal(localDate(Date.parse('2026-11-17T03:30:00Z'), 'America/New_York'), '2026-11-16');
});
