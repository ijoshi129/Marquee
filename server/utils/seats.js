// Seats and auditoriums as they travel between instances. What a friend's
// instance sends is arbitrary input, so both are checked on the way in as well
// as on the way out.

const SEAT = /^[A-Z]{1,2}\d{1,3}$/;
const AUDITORIUM = /^[A-Za-z0-9]{1,6}$/;
const MAX_SEATS = 12;

function cleanSeats(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const s of input) {
    const seat = typeof s === 'string' ? s.trim().toUpperCase() : '';
    if (SEAT.test(seat) && !out.includes(seat)) out.push(seat);
    if (out.length >= MAX_SEATS) break;
  }
  return out;
}

function cleanAuditorium(input) {
  const a = typeof input === 'string' || typeof input === 'number' ? String(input).trim() : '';
  return AUDITORIUM.test(a) ? a : null;
}

// Upcoming reservations as a friend should receive them: with the seat when
// the owner shares it, and with no trace of the fields when they do not.
function forFriends(rows, shareSeats) {
  return rows.map(({ auditorium, seats, ...rest }) =>
    shareSeats ? { ...rest, auditorium: cleanAuditorium(auditorium), seats: cleanSeats(seats) } : rest
  );
}

module.exports = { cleanSeats, cleanAuditorium, forFriends };
