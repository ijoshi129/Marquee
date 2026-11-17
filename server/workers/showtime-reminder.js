// One push before each booked show: where to go, where to sit, and roughly
// when it lets out. Everything in it comes from the reservation email.

const cron = require('node-cron');
const logger = require('../logger');
const { pool } = require('../db');
const notifications = require('../services/notifications');
const jobStatus = require('../services/job-status');
const { realShowtimeMs, clockLabel } = require('../utils/showtime');

const MIN = 60 * 1000;
const LEAD_MIN = Math.max(15, Number(process.env.SHOWTIME_REMINDER_MINUTES) || 120);
// AMC's own emails: "The movie will start 25-30 minutes after the listed showtime."
const TRAILERS_MIN = 25;

function reminderFor(w) {
  const where = [
    w.theater_name,
    w.auditorium ? `Auditorium ${w.auditorium}` : null,
    w.seats && w.seats.length ? `${w.seats.length > 1 ? 'Seats' : 'Seat'} ${w.seats.join(', ')}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const runtime = Number(w.runtime_minutes) || null;
  const timing = runtime
    ? `Film starts about ${clockLabel(w.showtime, TRAILERS_MIN)}, out by about ${clockLabel(w.showtime, TRAILERS_MIN + runtime)}.`
    : `Film starts about ${clockLabel(w.showtime, TRAILERS_MIN)}.`;
  return {
    kind: 'showtime',
    // The title AMC sold it under, so an Unseen stays an Unseen.
    title: `${w.title} at ${clockLabel(w.showtime)}`,
    body: [where, timing].filter(Boolean).join('. ').replace(/\.\./g, '.'),
    payload: { watch_id: w.id },
    // A showing moved to another time is a new reminder.
    dedupeKey: `showtime:${w.id}:${new Date(w.showtime).toISOString()}`,
  };
}

// Due when the show starts within the lead time and has not started yet. A
// booking made inside that window is reminded on the next pass.
function isDue(w, now) {
  const until = realShowtimeMs(w.showtime) - now;
  return until > 0 && until <= LEAD_MIN * MIN;
}

async function checkOnce(now = Date.now()) {
  try {
    const { rows } = await pool.query(
      `SELECT w.id, w.title, w.showtime, w.auditorium, w.seats,
              t.name AS theater_name, tc.payload->>'runtime_minutes' AS runtime_minutes
         FROM watches w
         LEFT JOIN theaters t ON t.id = w.theater_id
         LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
        WHERE w.status = 'pending' AND w.showtime IS NOT NULL
          AND w.showtime BETWEEN NOW() - INTERVAL '2 days' AND NOW() + INTERVAL '2 days'`
    );
    let sent = 0;
    for (const w of rows) {
      if (!isDue(w, now)) continue;
      if (await notifications.notify(reminderFor(w))) sent += 1;
    }
    await jobStatus.succeeded('reminders', { upcoming: rows.length, sent });
    return sent;
  } catch (err) {
    logger.error({ err }, 'showtime-reminder: check failed');
    await jobStatus.failed('reminders', err);
    return 0;
  }
}

let task = null;
function start() {
  logger.info(`showtime-reminder: starting (every 5 minutes, ${LEAD_MIN} minutes ahead)`);
  task = cron.schedule('*/5 * * * *', () => checkOnce());
  return task;
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, checkOnce, LEAD_MIN, _internal: { reminderFor, isDue } };
