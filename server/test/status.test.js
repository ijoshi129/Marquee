const assert = require('node:assert/strict');
const { test, afterEach } = require('./harness');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const { pool } = require('../db');
const jobStatus = require('../services/job-status');
const status = require('../services/status');
const notifications = require('../services/notifications');
const monitor = require('../workers/status-monitor');

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const ago = (ms) => new Date(NOW - ms).toISOString();

const scheduled = { key: 'email', name: 'AMC emails', staleMs: 30 * MIN };
const onDemand = { key: 'unseen', name: 'Screen Unseen lookup' };

const real = { query: pool.query, notify: notifications.notify, dueAlerts: status.dueAlerts, watchEnabled: status.watchEnabled };
afterEach(() => {
  pool.query = real.query;
  notifications.notify = real.notify;
  status.dueAlerts = real.dueAlerts;
  status.watchEnabled = real.watchEnabled;
  jobStatus.clearCache();
});

// An in-memory app_state.
function stubState() {
  const store = new Map();
  pool.query = async (sql, params) => {
    if (!/app_state/.test(sql)) throw new Error(`unexpected query: ${sql}`);
    if (/^\s*INSERT/.test(sql)) {
      store.set(params[0], params[1]);
      return { rows: [] };
    }
    return { rows: store.has(params[0]) ? [{ value: store.get(params[0]) }] : [] };
  };
  return store;
}

test('assess: a job that is not configured is off, whatever its history', () => {
  assert.equal(status.assess(scheduled, { failing_since: ago(DAY) }, false, NOW).level, 'off');
});

test('assess: a recent success is ok, and nothing reported yet is idle', () => {
  assert.equal(status.assess(scheduled, { last_run_at: ago(4 * MIN) }, true, NOW).level, 'ok');
  assert.equal(status.assess(scheduled, { since: ago(4 * MIN) }, true, NOW).level, 'idle');
  assert.equal(status.assess(onDemand, {}, true, NOW).level, 'idle');
});

test('assess: an erroring job fails from when the errors began', () => {
  const v = status.assess(
    scheduled,
    { last_run_at: ago(MIN), failing_since: ago(3 * HOUR), last_error: 'Invalid credentials' },
    true,
    NOW
  );
  assert.deepEqual(
    { level: v.level, since: v.since, problem: v.problem },
    { level: 'fail', since: ago(3 * HOUR), problem: 'Invalid credentials' }
  );
});

test('assess: a scheduled job that goes quiet fails, an on-demand one does not', () => {
  const quiet = status.assess(scheduled, { last_run_at: ago(2 * HOUR) }, true, NOW);
  assert.equal(quiet.level, 'fail');
  assert.equal(quiet.stale, true);
  // It became stale once staleMs had passed, not when it last ran.
  assert.equal(quiet.since, ago(2 * HOUR - 30 * MIN));

  // Never reported at all, measured from when it was first watched.
  assert.equal(status.assess(scheduled, { since: ago(2 * HOUR) }, true, NOW).level, 'fail');
  assert.equal(status.assess(onDemand, { last_run_at: ago(30 * DAY) }, true, NOW).level, 'ok');
});

test('alertFor: waits a day, then speaks once per outage', () => {
  const failing = (since, failures) => {
    const state = { last_run_at: ago(MIN), failing_since: since, failures, last_error: 'Reddit 403' };
    return status.alertFor(scheduled, state, status.assess(scheduled, state, true, NOW), NOW);
  };
  assert.equal(failing(ago(23 * HOUR), 50), null);

  const alert = failing(ago(25 * HOUR), 50);
  assert.equal(alert.title, 'AMC emails: failing for over a day');
  assert.equal(alert.body, 'Reddit 403');
  // Keyed on when the trouble began, so the hourly check repeats the same key.
  assert.equal(alert.dedupeKey, `status:email:${ago(25 * HOUR)}`);
  assert.equal(failing(ago(40 * HOUR), 80).dedupeKey, `status:email:${ago(40 * HOUR)}`);
});

test('alertFor: a single failed attempt is not an outage', () => {
  const state = { last_run_at: ago(3 * DAY), failing_since: ago(3 * DAY), failures: 1 };
  assert.equal(status.alertFor(onDemand, state, status.assess(onDemand, state, true, NOW), NOW), null);
});

test('alertFor: a job silent for over a day is reported as not running', () => {
  const state = { last_run_at: ago(2 * DAY) };
  const alert = status.alertFor(scheduled, state, status.assess(scheduled, state, true, NOW), NOW);
  assert.equal(alert.title, 'AMC emails: not running for over a day');
  assert.match(alert.dedupeKey, /^status:email:stale:/);

  const fresh = { last_run_at: ago(2 * HOUR) };
  assert.equal(status.alertFor(scheduled, fresh, status.assess(scheduled, fresh, true, NOW), NOW), null);
});

test('job-status: failures accumulate from the first one and a success clears them', async () => {
  const store = stubState();

  const first = await jobStatus.failed('email', new Error('Invalid credentials'));
  const second = await jobStatus.failed('email', new Error('Connection timed out'));
  assert.equal(second.failures, 2);
  assert.equal(second.failing_since, first.failing_since);
  assert.equal(second.last_error, 'Connection timed out');

  const ok = await jobStatus.succeeded('email', { added: 1 });
  assert.equal(ok.failing_since, null);
  assert.equal(ok.failures, 0);
  assert.deepEqual(ok.detail, { added: 1 });
  // The last error stays on record after recovery.
  assert.equal(ok.last_error, 'Connection timed out');

  // Persisted, so a restart picks the history back up.
  jobStatus.clearCache();
  assert.equal((await jobStatus.get('email')).last_error, 'Connection timed out');
  assert.ok(store.has('job:email'));
});

test('job-status: a database error never reaches the job being recorded', async () => {
  pool.query = async () => {
    throw new Error('connection refused');
  };
  const state = await jobStatus.succeeded('email', { added: 0 });
  assert.equal(state.failures, 0);
});

test('job-status: long errors are cut down', async () => {
  stubState();
  const state = await jobStatus.failed('email', new Error('x'.repeat(5000)));
  assert.equal(state.last_error.length, 300);
});

test('status-monitor: sends each due alert through the notification layer', async () => {
  const sent = [];
  status.watchEnabled = async () => {};
  status.dueAlerts = async () => [
    { key: 'email', dedupeKey: 'status:email:t', title: 'AMC emails: failing for over a day', body: 'Invalid credentials' },
  ];
  notifications.notify = async (n) => sent.push(n);

  await monitor.checkOnce();

  assert.deepEqual(sent, [
    {
      kind: 'status',
      title: 'AMC emails: failing for over a day',
      body: 'Invalid credentials',
      payload: { status: 'email' },
      dedupeKey: 'status:email:t',
    },
  ]);
});

test('job-status: a failed read falls back to the last known state, not a blank one', async () => {
  stubState();
  await jobStatus.failed('email', new Error('Invalid credentials'));
  const working = pool.query;

  pool.query = async (sql, params) => {
    if (/^\s*SELECT/.test(sql)) throw new Error('connection refused');
    return working(sql, params);
  };
  const next = await jobStatus.failed('email', new Error('Invalid credentials'));
  assert.equal(next.failures, 2);
});

test('job-status: a network failure records its cause, not just "fetch failed"', async () => {
  stubState();
  const err = new TypeError('fetch failed');
  err.cause = { code: 'ECONNREFUSED' };
  assert.equal((await jobStatus.failed('ntfy', err)).last_error, 'fetch failed (ECONNREFUSED)');
});
