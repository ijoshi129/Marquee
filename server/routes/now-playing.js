const express = require('express');
const logger = require('../logger');
const fandango = require('../services/fandango');
const nowPlaying = require('../services/now-playing');
const unseenGuess = require('../services/unseen-guess');
const alerts = require('../services/now-playing-alerts');

const router = express.Router();

const MAX_COUNT_HASHES = 16;

function fail(res, err, what) {
  nowPlaying.recordFailure(err);
  if (err instanceof fandango.FandangoError && err.status < 500) {
    return res.status(err.status).json({ error: err.message });
  }
  logger.error({ err }, `now-playing: ${what}`);
  const upstream = err instanceof fandango.FandangoError || err.name === 'AbortError' || err.cause;
  res
    .status(upstream ? 502 : 500)
    .json({ error: upstream ? 'Showtimes are not answering right now' : 'Server error' });
}

router.get('/theatres', async (req, res) => {
  try {
    res.json(await nowPlaying.theatresForView());
  } catch (err) {
    logger.error({ err }, 'now-playing: read theatres');
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/theatres', async (req, res) => {
  try {
    res.json(await nowPlaying.theatresForView(await nowPlaying.setTheatres(req.body)));
  } catch (err) {
    logger.error({ err }, 'now-playing: save theatres');
    res.status(500).json({ error: 'Server error' });
  }
});

router.get('/theatres/search', async (req, res) => {
  try {
    res.json(await fandango.searchTheatres(req.query.q));
  } catch (err) {
    fail(res, err, 'theatre search');
  }
});

// One theatre, one day: the films with their showtimes, plus the dates that
// have any, so the date strip needs no second request.
router.get('/showtimes', async (req, res) => {
  try {
    const theatre = String(req.query.theatre || '');
    const date = req.query.date ? String(req.query.date) : null;
    const [board, cal] = await Promise.all([
      fandango.showtimes(theatre, date),
      fandango.calendar(theatre).catch(() => ({ dates: [], first: null })),
    ]);
    const films = await nowPlaying.fillPosters(await nowPlaying.flagFilms(board.films));
    nowPlaying.recordSuccess({ theatre: theatre.toUpperCase(), films: films.length });
    res.json({ date: board.date || date, dates: cal.dates, films });
  } catch (err) {
    fail(res, err, 'showtimes');
  }
});

// A stand-in for a poster whose link turned out to be dead. The client only
// finds that out when the image fails to load, so it asks then.
router.get('/poster', async (req, res) => {
  const title = String(req.query.title || '').slice(0, 200);
  const year = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : null;
  if (!title.trim()) return res.status(400).json({ error: 'title is required' });
  try {
    res.json({ poster_url: await nowPlaying.tmdbPoster(title, year) });
  } catch (err) {
    logger.warn(`now-playing: poster lookup failed for "${title}": ${err.message}`);
    res.json({ poster_url: null });
  }
});

// More about one film on the board: synopsis, cast, score, trailer.
router.get('/film', async (req, res) => {
  const title = String(req.query.title || '').slice(0, 200);
  const year = /^\d{4}$/.test(String(req.query.year || '')) ? Number(req.query.year) : null;
  if (!title.trim()) return res.status(400).json({ error: 'title is required' });
  try {
    res.json({ info: await nowPlaying.filmInfo(title, year) });
  } catch (err) {
    logger.warn(`now-playing: film info failed for "${title}": ${err.message}`);
    res.status(502).json({ error: 'Film details are not answering right now' });
  }
});

// Guesses at what an upcoming Unseen is. Asked for only when the owner taps to
// see them: the sheet never loads this on its own.
router.get('/unseen-guesses', async (req, res) => {
  const date = String(req.query.date || '');
  const kind = String(req.query.kind || '');
  const rating = /^(G|PG|PG-13|R|NC-17)$/i.test(String(req.query.rating || '')) ? String(req.query.rating).toUpperCase() : null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !['screen', 'scream'].includes(kind)) {
    return res.status(400).json({ error: 'date and kind are required' });
  }
  try {
    res.json(await unseenGuess.guesses({ date, kind, rating }));
  } catch (err) {
    logger.warn(`now-playing: unseen guesses failed for ${date}: ${err.message}`);
    res.status(502).json({ error: 'Could not work out candidates right now' });
  }
});

// Showings the owner asked to be told about when they fill up.
router.get('/watching', async (req, res) => {
  try {
    res.json(await alerts.listWatching());
  } catch (err) {
    logger.error({ err }, 'now-playing: list watched showings');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/watching', async (req, res) => {
  try {
    const added = await alerts.watchShowing(req.body);
    if (!added) return res.status(400).json({ error: 'That showing cannot be watched' });
    res.json(await alerts.listWatching());
  } catch (err) {
    logger.error({ err }, 'now-playing: watch a showing');
    res.status(500).json({ error: 'Server error' });
  }
});

router.delete('/watching/:hash', async (req, res) => {
  try {
    await alerts.unwatchShowing(req.params.hash);
    res.json(await alerts.listWatching());
  } catch (err) {
    logger.error({ err }, 'now-playing: stop watching a showing');
    res.status(500).json({ error: 'Server error' });
  }
});

router.post('/seats/counts', async (req, res) => {
  try {
    const hashes = Array.isArray(req.body.hashes) ? req.body.hashes : [];
    const valid = [...new Set(hashes.filter((h) => fandango.SHOWTIME_HASH.test(String(h || ''))))];
    res.json(await fandango.seatCounts(valid.slice(0, MAX_COUNT_HASHES)));
  } catch (err) {
    fail(res, err, 'seat counts');
  }
});

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.get('/booking/:watchId', async (req, res) => {
  if (!UUID_RX.test(req.params.watchId)) return res.status(404).json({ error: 'Not found' });
  try {
    const out = await nowPlaying.bookingSeats(req.params.watchId);
    if (!out) return res.status(404).json({ error: 'Not found' });
    res.json(out);
  } catch (err) {
    fail(res, err, 'booking seats');
  }
});

router.get('/seats/:hash', async (req, res) => {
  try {
    res.json(await fandango.seatMap(req.params.hash));
  } catch (err) {
    fail(res, err, 'seat map');
  }
});

module.exports = router;
