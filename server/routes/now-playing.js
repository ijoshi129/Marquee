const express = require('express');
const logger = require('../logger');
const fandango = require('../services/fandango');
const nowPlaying = require('../services/now-playing');

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
    res.json(await nowPlaying.getTheatres());
  } catch (err) {
    logger.error({ err }, 'now-playing: read theatres');
    res.status(500).json({ error: 'Server error' });
  }
});

router.put('/theatres', async (req, res) => {
  try {
    res.json(await nowPlaying.setTheatres(req.body));
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
    const films = await nowPlaying.flagFilms(board.films);
    nowPlaying.recordSuccess({ theatre: theatre.toUpperCase(), films: films.length });
    res.json({ date: board.date || date, dates: cal.dates, films });
  } catch (err) {
    fail(res, err, 'showtimes');
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

router.get('/seats/:hash', async (req, res) => {
  try {
    res.json(await fandango.seatMap(req.params.hash));
  } catch (err) {
    fail(res, err, 'seat map');
  }
});

module.exports = router;
