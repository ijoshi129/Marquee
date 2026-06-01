const express = require('express');
const logger = require('../logger');
const { pool } = require('../db');
const { displayTitle } = require('../utils/normalize');

const router = express.Router();

// A-List value: a flat monthly fee buys the films; this estimates what those
// tickets would have cost out of pocket. Prices are config so they can track a
// region without code changes; defaults match the owner's plan.
const ALIST = {
  fee: Number(process.env.ALIST_MONTHLY_FEE) || 27.71,
  ticket: Number(process.env.ALIST_TICKET_PRICE) || 16,
  premium: Number(process.env.ALIST_PREMIUM_SURCHARGE) || 5,
};
const PREMIUM_FORMATS = new Set([
  'IMAX', 'Dolby Cinema', 'Dolby Atmos', 'Prime', 'XD', 'MX4D', 'D-Box', 'RealD 3D', '3D',
]);
const round2 = (n) => Math.round(n * 100) / 100;

function monthBounds(monthParam) {
  const now = new Date();
  let year = now.getUTCFullYear();
  let month = now.getUTCMonth();
  if (monthParam) {
    const m = /^(\d{4})-(\d{2})$/.exec(monthParam);
    if (!m) throw new Error('month must be YYYY-MM');
    year = Number(m[1]);
    month = Number(m[2]) - 1;
  }
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
    label: `${year}-${String(month + 1).padStart(2, '0')}`,
  };
}

function periodBounds(period, monthParam) {
  if (period === 'all') {
    return {
      start: new Date(Date.UTC(2000, 0, 1)),
      end: new Date(Date.UTC(2100, 0, 1)),
      label: 'all',
    };
  }
  if (period === 'year') {
    const year = (monthParam ? Number(monthParam.slice(0, 4)) : null) || new Date().getUTCFullYear();
    return {
      start: new Date(Date.UTC(year, 0, 1)),
      end: new Date(Date.UTC(year + 1, 0, 1)),
      label: String(year),
    };
  }
  return monthBounds(monthParam);
}

router.get('/', async (req, res) => {
  try {
    const period = req.query.period || 'month';
    const { start, end, label } = periodBounds(period, req.query.month);

    const watchesQ = await pool.query(
      `SELECT w.id, w.tmdb_id, w.title, w.rating, w.watched_at, w.tags, t.name AS theater_name, tc.payload AS tmdb
       FROM watches w
       LEFT JOIN theaters t ON t.id = w.theater_id
       LEFT JOIN tmdb_cache tc ON tc.tmdb_id = w.tmdb_id
       WHERE w.status = 'watched'
         AND w.watched_at >= $1 AND w.watched_at < $2
       ORDER BY w.watched_at DESC`,
      [start.toISOString(), end.toISOString()]
    );

    const watches = watchesQ.rows;
    const count = watches.length;

    // Lifetime watch counts so the recap can flag films seen before. Cheap
    // group-by over the whole table, intersected with this period's films.
    const rewatchQ = await pool.query(
      `SELECT tmdb_id, COUNT(*)::int AS total
       FROM watches
       WHERE status = 'watched' AND tmdb_id IS NOT NULL
       GROUP BY tmdb_id
       HAVING COUNT(*) >= 2`
    );
    const rewatchTotals = new Map(rewatchQ.rows.map((r) => [r.tmdb_id, r.total]));

    let totalRuntime = 0;
    const genreCounts = new Map();
    const theaterCounts = new Map();
    const directorCounts = new Map();
    const formatCounts = new Map();
    const monthBuckets = new Map(); // 'YYYY-MM' -> count
    const dayBuckets = new Map(); // 'YYYY-MM-DD' -> count
    let ratingSum = 0;
    let ratingCount = 0;
    let fiveStarCount = 0;
    let longest = null;
    let ticketValue = 0;
    let premiumTickets = 0;

    for (const w of watches) {
      const t = w.tmdb || {};
      const isPremium = (w.tags || []).some((tag) => PREMIUM_FORMATS.has(tag));
      ticketValue += ALIST.ticket + (isPremium ? ALIST.premium : 0);
      if (isPremium) premiumTickets += 1;
      if (typeof t.runtime_minutes === 'number') {
        totalRuntime += t.runtime_minutes;
        if (!longest || t.runtime_minutes > longest.runtime_minutes) {
          longest = {
            title: t.title || w.title,
            runtime_minutes: t.runtime_minutes,
            poster_url: t.poster_url || null,
          };
        }
      }
      for (const g of t.genres || []) {
        genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
      }
      if (w.theater_name) {
        theaterCounts.set(w.theater_name, (theaterCounts.get(w.theater_name) || 0) + 1);
      }
      if (t.director) {
        directorCounts.set(t.director, (directorCounts.get(t.director) || 0) + 1);
      }
      for (const tag of w.tags || []) {
        formatCounts.set(tag, (formatCounts.get(tag) || 0) + 1);
      }
      if (typeof w.rating === 'number') {
        ratingSum += w.rating;
        ratingCount++;
        if (w.rating === 5) fiveStarCount++;
      }
      if (w.watched_at) {
        const d = new Date(w.watched_at);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        monthBuckets.set(key, (monthBuckets.get(key) || 0) + 1);
        const dayKey = `${key}-${String(d.getUTCDate()).padStart(2, '0')}`;
        dayBuckets.set(dayKey, (dayBuckets.get(dayKey) || 0) + 1);
      }
    }

    let busiestDay = null;
    for (const [date, n] of dayBuckets) {
      if (!busiestDay || n > busiestDay.count) busiestDay = { date, count: n };
    }

    const recent = watches.slice(0, 6).map((w) => ({
      id: w.id,
      title: displayTitle(w.title, w.tmdb?.title),
      poster_url: w.tmdb?.poster_url || null,
      rating: w.rating,
      watched_at: w.watched_at,
      theater_name: w.theater_name,
    }));

    const films = watches.slice(0, 60).map((w) => ({
      id: w.id,
      title: displayTitle(w.title, w.tmdb?.title),
      poster_url: w.tmdb?.poster_url || null,
      rating: w.rating,
    }));

    // Films watched in this period that the user has seen 2+ times overall.
    const rewatchSeen = new Set();
    const rewatches = [];
    for (const w of watches) {
      if (!w.tmdb_id || rewatchSeen.has(w.tmdb_id)) continue;
      const total = rewatchTotals.get(w.tmdb_id);
      if (!total) continue;
      rewatchSeen.add(w.tmdb_id);
      rewatches.push({
        id: w.id,
        title: displayTitle(w.title, w.tmdb?.title),
        poster_url: w.tmdb?.poster_url || null,
        total,
      });
    }
    rewatches.sort((a, b) => b.total - a.total);

    const response = {
      period,
      label,
      from: start.toISOString().slice(0, 10),
      to: end.toISOString().slice(0, 10),
      count,
      total_runtime_minutes: totalRuntime,
      average_rating: ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null,
      genres: [...genreCounts.entries()]
        .map(([name, n]) => ({ name, count: n }))
        .sort((a, b) => b.count - a.count),
      theaters: [...theaterCounts.entries()]
        .map(([name, n]) => ({ name, count: n }))
        .sort((a, b) => b.count - a.count),
      formats: [...formatCounts.entries()]
        .map(([name, n]) => ({ name, count: n }))
        .sort((a, b) => b.count - a.count),
      top_directors: [...directorCounts.entries()]
        .map(([name, n]) => ({ name, count: n }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      top_rated: watches
        .filter((w) => w.rating === 5)
        .slice(0, 12)
        .map((w) => ({
          id: w.id,
          title: displayTitle(w.title, w.tmdb?.title),
          poster_url: w.tmdb?.poster_url || null,
          watched_at: w.watched_at,
        })),
      recent,
      films,
      rewatches,
      superlatives: {
        busiest_day: busiestDay,
        longest_film: longest,
        five_star_count: fiveStarCount,
      },
    };

    // Bill only the months with at least one watch. Counting every calendar
    // month since the first watch would assume continuous membership and
    // punish gaps; this answers "while I was using A-List, did it pay off?"
    const months = period === 'month' ? 1 : Math.max(1, monthBuckets.size);
    const fee = round2(ALIST.fee * months);
    response.value = {
      tickets: count,
      premium_tickets: premiumTickets,
      ticket_value: round2(ticketValue),
      monthly_fee: ALIST.fee,
      months,
      fee,
      savings: round2(ticketValue - fee),
    };

    // The month-over-month cadence chart is only meaningful across a year or
    // all-time; a single month has nothing to chart.
    if (period !== 'month') {
      // Pick a sensible window for the monthly chart:
      //   - period='year': always show 12 months of that year (zero-buckets included).
      //   - period='all':  from the earliest actual watched_at (or its month) up to
      //                    the current calendar month, so we don't show 20 years of
      //                    pre-data zeros.
      const monthly = [];
      let cursor;
      let stop;
      if (period === 'year') {
        cursor = new Date(start);
        stop = new Date(end);
      } else {
        // period='all'. Start at January of the earliest year so the timeline
        // is calendar-year aligned — the client groups it into per-year rows
        // for the cadence chart and that grouping only reads cleanly when
        // each year starts with January.
        const earliestMs = watches.reduce((min, w) => {
          const t = w.watched_at ? new Date(w.watched_at).getTime() : Infinity;
          return t < min ? t : min;
        }, Infinity);
        const earliest = Number.isFinite(earliestMs) ? new Date(earliestMs) : new Date();
        cursor = new Date(Date.UTC(earliest.getUTCFullYear(), 0, 1));
        const now = new Date();
        stop = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      }
      while (cursor < stop && monthly.length < 240) {
        const key = `${cursor.getUTCFullYear()}-${String(
          cursor.getUTCMonth() + 1
        ).padStart(2, '0')}`;
        monthly.push({ month: key, count: monthBuckets.get(key) || 0 });
        cursor.setUTCMonth(cursor.getUTCMonth() + 1);
      }
      response.monthly_breakdown = monthly;
    }

    res.json(response);
  } catch (err) {
    logger.error({ err: err }, 'stats');
    res.status(500).json({ error: err.message || 'Server error' });
  }
});

module.exports = router;
