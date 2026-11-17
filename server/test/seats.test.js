const assert = require('node:assert/strict');
const { test } = require('./harness');

const { cleanSeats, cleanAuditorium, forFriends } = require('../utils/seats');

test('seats: only things shaped like a seat get through, tidied and without repeats', () => {
  assert.deepEqual(cleanSeats(['G8', ' f9 ', 'WC1', 'G8', 'AA12']), ['G8', 'F9', 'WC1', 'AA12']);
  // What a friend's instance sends could be anything.
  assert.deepEqual(cleanSeats(['<b>G8</b>', 'G', '8', 'GGG8', 'G1234', 12, null, { id: 'G8' }, 'G8; DROP']), []);
  assert.deepEqual(cleanSeats('G8'), []);
  assert.deepEqual(cleanSeats(undefined), []);
  assert.equal(cleanSeats(Array.from({ length: 40 }, (_, i) => `A${i + 1}`)).length, 12);
});

test('seats: an auditorium is a short number or code, or nothing', () => {
  assert.equal(cleanAuditorium('17'), '17');
  assert.equal(cleanAuditorium(7), '7');
  assert.equal(cleanAuditorium(' IMAX '), 'IMAX');
  assert.equal(cleanAuditorium('the big one'), null);
  assert.equal(cleanAuditorium('1234567'), null);
  assert.equal(cleanAuditorium(null), null);
  assert.equal(cleanAuditorium({}), null);
});

test('seats: friends get the seat only when it is shared, and no trace of it otherwise', () => {
  const rows = [
    { remote_id: 'w1', title: 'Clayface', showtime: '2026-11-21T19:00:00.000Z', auditorium: '7', seats: ['F8', 'F9'] },
    { remote_id: 'w2', title: 'Hand Entered', showtime: '2026-11-22T19:00:00.000Z', auditorium: null, seats: null },
  ];
  assert.deepEqual(forFriends(rows, true), [
    { remote_id: 'w1', title: 'Clayface', showtime: '2026-11-21T19:00:00.000Z', auditorium: '7', seats: ['F8', 'F9'] },
    { remote_id: 'w2', title: 'Hand Entered', showtime: '2026-11-22T19:00:00.000Z', auditorium: null, seats: [] },
  ]);
  const hidden = forFriends(rows, false);
  assert.deepEqual(hidden[0], { remote_id: 'w1', title: 'Clayface', showtime: '2026-11-21T19:00:00.000Z' });
  assert.equal('seats' in hidden[0] || 'auditorium' in hidden[0], false);
});
