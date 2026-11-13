const assert = require('node:assert/strict');
const { test, afterEach } = require('./harness');

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgres://test/test';
const { pool } = require('../db');
const poller = require('../workers/email-poller');

const { knownIdsFrom, ingestPhase } = poller._internal;

const realQuery = pool.query;
const realEnv = { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD };
afterEach(() => {
  pool.query = realQuery;
  for (const [k, v] of [['GMAIL_USER', realEnv.user], ['GMAIL_APP_PASSWORD', realEnv.pass]]) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('knownIdsFrom reaches back to the start of the day before the search instant', () => {
  assert.equal(knownIdsFrom('2026-11-12T17:07:00.000Z').toISOString(), '2026-11-11T00:00:00.000Z');
  assert.equal(knownIdsFrom('2026-11-12T00:00:00.000Z').toISOString(), '2026-11-11T00:00:00.000Z');
  // Across a month and a year boundary.
  assert.equal(knownIdsFrom('2026-12-01T03:00:00.000Z').toISOString(), '2026-11-30T00:00:00.000Z');
  assert.equal(knownIdsFrom('2027-01-01T23:59:00.000Z').toISOString(), '2026-12-31T00:00:00.000Z');
});

test('an email from earlier on the boundary day counts as already held', async () => {
  // The mail search is by date, so with the newest email at 17:07 on the 13th
  // it returns everything from the 12th on, including one from 14:43 that day.
  // That one used to fall outside the ids handed to the fetcher.
  const stored = [
    { gmail_message_id: 'new', received_at: new Date('2026-11-13T17:07:00Z') },
    { gmail_message_id: 'boundary-day', received_at: new Date('2026-11-12T14:43:00Z') },
    { gmail_message_id: 'last-week', received_at: new Date('2026-11-05T14:43:00Z') },
  ];
  let knownFrom = null;
  let held = null;
  pool.query = async (sql, params) => {
    if (/MAX\(received_at\)/.test(sql)) return { rows: [{ max_received: stored[0].received_at }] };
    if (/SELECT gmail_message_id FROM email_log/.test(sql)) {
      knownFrom = params[0];
      held = stored.filter((r) => r.received_at >= params[0]).map((r) => r.gmail_message_id);
      return { rows: held.map((id) => ({ gmail_message_id: id })) };
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  // No mail account in tests: the fetch refuses, after the lookups under test.
  delete process.env.GMAIL_USER;
  delete process.env.GMAIL_APP_PASSWORD;
  await assert.rejects(ingestPhase(), /GMAIL_USER/);

  assert.equal(knownFrom.toISOString(), '2026-11-11T00:00:00.000Z');
  assert.deepEqual(held, ['new', 'boundary-day']);
});
