const assert = require('node:assert/strict');
const { test, afterEach } = require('./harness');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const { pool } = require('../db');
const unseenLookup = require('../services/unseen-lookup');
const notifications = require('../services/notifications');
const { recheckOnce } = require('../workers/tmdb-rechecker');

const real = {
  query: pool.query,
  resolve: unseenLookup.resolveAndAssign,
  notify: notifications.notify,
};
afterEach(() => {
  pool.query = real.query;
  unseenLookup.resolveAndAssign = real.resolve;
  notifications.notify = real.notify;
});

const HOUR = 60 * 60 * 1000;

function unseen(over = {}) {
  return {
    id: 'w1',
    title: 'AMC Screen Unseen: October 19',
    tags: ['Screen Unseen'],
    status: 'watched',
    showtime: '2026-10-19T19:00:00.000Z',
    watched_at: '2026-10-19T19:00:00.000Z',
    tmdb_retry_count: 0,
    tmdb_last_retry_at: null,
    ...over,
  };
}

// Runs one cycle over `rows` with every lookup missing; reports what it did.
async function cycle(rows) {
  const seen = { select: null, bumped: [], looked: [], notified: [] };
  pool.query = async (sql, params) => {
    if (/^\s*SELECT/.test(sql)) {
      seen.select = { sql, params };
      return { rows };
    }
    if (/tmdb_retry_count = tmdb_retry_count \+ 1/.test(sql)) {
      seen.bumped.push(params[0]);
      return { rows: [] };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  unseenLookup.resolveAndAssign = async (id) => {
    seen.looked.push(id);
    return { resolved: false, reason: 'no megathread entry' };
  };
  notifications.notify = async (n) => {
    seen.notified.push(n);
    return n;
  };
  await recheckOnce();
  return seen;
}

test('rechecker gives Unseens a longer retry budget than other films', async () => {
  const seen = await cycle([]);
  const [regular, unseenMax] = seen.select.params;
  assert.equal(regular, 8);
  assert.ok(unseenMax > regular);
  assert.match(seen.select.sql, /Screen Unseen/);
});

test('rechecker asks the owner to identify an Unseen when the fast retries run out', async () => {
  const seen = await cycle([unseen({ tmdb_retry_count: 7 })]);
  assert.deepEqual(seen.bumped, ['w1']);
  assert.equal(seen.notified.length, 1);
  assert.equal(seen.notified[0].title, 'What was your Screen Unseen on Oct 19?');
  assert.deepEqual(seen.notified[0].payload, { watch_id: 'w1' });
  assert.equal(seen.notified[0].dedupeKey, 'identify:w1');
});

test('rechecker only nudges once, at the end of the fast phase', async () => {
  const early = await cycle([unseen({ tmdb_retry_count: 3 })]);
  assert.equal(early.notified.length, 0);
  const late = await cycle([
    unseen({ tmdb_retry_count: 12, tmdb_last_retry_at: new Date(Date.now() - 30 * HOUR) }),
  ]);
  assert.deepEqual(late.bumped, ['w1']);
  assert.equal(late.notified.length, 0);
});

test('rechecker does not nudge about a screening the owner skipped', async () => {
  const seen = await cycle([
    unseen({ id: 'c', status: 'cancelled', tmdb_retry_count: 7 }),
    unseen({ id: 'n', status: 'no_show', tmdb_retry_count: 7 }),
  ]);
  assert.deepEqual(seen.bumped, ['c', 'n']);
  assert.equal(seen.notified.length, 0);
});

test('rechecker tries a slow-phase Unseen once a day, not every cycle', async () => {
  const seen = await cycle([
    unseen({ id: 'recent', tmdb_retry_count: 9, tmdb_last_retry_at: new Date(Date.now() - 6 * HOUR) }),
    unseen({ id: 'due', tmdb_retry_count: 9, tmdb_last_retry_at: new Date(Date.now() - 24 * HOUR) }),
    unseen({ id: 'fast', tmdb_retry_count: 2, tmdb_last_retry_at: new Date(Date.now() - 6 * HOUR) }),
  ]);
  assert.deepEqual(seen.looked, ['due', 'fast']);
  assert.deepEqual(seen.bumped, ['due', 'fast']);
});
