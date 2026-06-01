const assert = require('node:assert/strict');
const { test, afterEach } = require('./harness');

function response(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body ?? {})),
    json: async () => {
      if (typeof body === 'string') return JSON.parse(body);
      return body ?? {};
    },
  };
}

function clearModules() {
  for (const mod of [
    '../db',
    '../logger',
    '../services/trakt-http',
    '../services/trakt',
    '../workers/trakt-sync',
  ]) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch {
      /* module may not have been loaded */
    }
  }
}

function mockModule(request, exports) {
  require.cache[require.resolve(request)] = {
    id: require.resolve(request),
    filename: require.resolve(request),
    loaded: true,
    exports,
  };
}

function withEnv(values) {
  const previous = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    process.env[key] = values[key];
  }
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function createPool(row) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (/SELECT id, title, tmdb_id/.test(sql)) {
        return { rows: [row], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
}

function loadTrakt({ pool, fetches, envUpdates = [] }) {
  clearModules();
  mockModule('../db', { pool });
  mockModule('../logger', {
    info() {},
    warn() {},
    error() {},
  });
  mockModule('../services/trakt-http', {
    traktFetch: async (pathname, options) => {
      if (!fetches.length) throw new Error(`Unexpected Trakt request: ${pathname}`);
      const next = fetches.shift();
      return next(pathname, options);
    },
    writeEnvFile: (_envPath, updates) => {
      envUpdates.push(updates);
    },
  });
  return require('../services/trakt');
}

function loadWorker({ rows, results }) {
  clearModules();
  const queries = [];
  mockModule('../db', {
    pool: {
      queries,
      async query(sql, params = []) {
        queries.push({ sql, params });
        return { rows, rowCount: rows.length };
      },
    },
  });
  mockModule('../logger', {
    info() {},
    warn() {},
    error() {},
  });
  mockModule('../services/trakt', {
    isConfigured: () => true,
    syncWatch: async () => results.shift(),
  });
  return { worker: require('../workers/trakt-sync'), queries };
}

const watchedAt = '2026-01-01T20:00:00.000Z';
const baseRow = {
  id: 'watch-1',
  title: 'Heat',
  tmdb_id: 949,
  showtime: watchedAt,
  watched_at: null,
  status: 'watched',
  trakt_synced_at: null,
  trakt_history_id: null,
};

afterEach(() => {
  clearModules();
});

test('syncWatch marks an existing Trakt play as synced without posting a duplicate', async () => {
  const restoreEnv = withEnv({
    TRAKT_CLIENT_ID: 'client-id',
    TRAKT_ACCESS_TOKEN: 'access-token',
  });
  const pool = createPool(baseRow);
  const requests = [];
  const trakt = loadTrakt({
    pool,
    fetches: [
      (pathname) => {
        requests.push(pathname);
        return response(200, [{ id: 12345, movie: { ids: { tmdb: 949 } } }]);
      },
    ],
  });

  const result = await trakt.syncWatch('watch-1');
  restoreEnv();

  assert.equal(result.synced, true);
  assert.equal(result.skipped, 'already_on_trakt');
  assert.equal(requests.length, 1);
  assert.match(requests[0], /^\/sync\/history\/movies\?/);
  assert(!requests.some((p) => p === '/sync/history'));

  const update = pool.calls.find((call) => /trakt_synced_at = NOW\(\)/.test(call.sql));
  assert(update, 'expected local row to be marked synced');
  assert.deepEqual(update.params, ['watch-1', 12345]);
});

test('preflight duplicate lookup uses a five-hour window centered on watched_at', async () => {
  const restoreEnv = withEnv({
    TRAKT_CLIENT_ID: 'client-id',
    TRAKT_ACCESS_TOKEN: 'access-token',
  });
  const pool = createPool(baseRow);
  let historyPath = null;
  const trakt = loadTrakt({
    pool,
    fetches: [
      (pathname) => {
        historyPath = pathname;
        return response(200, [{ id: 12345, movie: { ids: { tmdb: 949 } } }]);
      },
    ],
  });

  await trakt.syncWatch('watch-1');
  restoreEnv();

  const url = new URL(`https://api.trakt.tv${historyPath}`);
  const start = Date.parse(url.searchParams.get('start_at'));
  const end = Date.parse(url.searchParams.get('end_at'));
  const center = Date.parse(watchedAt);

  assert.equal(end - start, 5 * 60 * 60 * 1000);
  assert.equal(start, center - 2.5 * 60 * 60 * 1000);
  assert.equal(end, center + 2.5 * 60 * 60 * 1000);
});

test('syncWatch fails closed when duplicate preflight cannot read Trakt history', async () => {
  const restoreEnv = withEnv({
    TRAKT_CLIENT_ID: 'client-id',
    TRAKT_ACCESS_TOKEN: 'access-token',
  });
  const pool = createPool(baseRow);
  const requests = [];
  const trakt = loadTrakt({
    pool,
    fetches: [
      (pathname) => {
        requests.push(pathname);
        return response(503, { error: 'temporary outage' });
      },
    ],
  });

  const result = await trakt.syncWatch('watch-1');
  restoreEnv();

  assert.equal(result.synced, false);
  assert.match(result.error, /Trakt history lookup failed: HTTP 503/);
  assert.deepEqual(requests, [requests[0]]);
  assert.match(requests[0], /^\/sync\/history\/movies\?/);
  assert(!requests.includes('/sync/history'));

  const errorUpdate = pool.calls.find((call) => /trakt_sync_attempts = trakt_sync_attempts \+ 1/.test(call.sql));
  assert(errorUpdate, 'expected failed preflight to record a sync attempt');
});

test('syncWatch refreshes an expired token before deciding a Trakt play is absent', async () => {
  const restoreEnv = withEnv({
    TRAKT_CLIENT_ID: 'client-id',
    TRAKT_CLIENT_SECRET: 'client-secret',
    TRAKT_ACCESS_TOKEN: 'old-token',
    TRAKT_REFRESH_TOKEN: 'refresh-token',
    TRAKT_REDIRECT_URI: 'http://localhost:3000',
  });
  const pool = createPool(baseRow);
  const envUpdates = [];
  const requests = [];
  const trakt = loadTrakt({
    pool,
    envUpdates,
    fetches: [
      (pathname) => {
        requests.push(pathname);
        return response(401, { error: 'expired' });
      },
      (pathname) => {
        requests.push(pathname);
        assert.equal(pathname, '/oauth/token');
        return response(200, {
          access_token: 'new-token',
          refresh_token: 'new-refresh',
          created_at: 100,
          expires_in: 3600,
        });
      },
      (pathname) => {
        requests.push(pathname);
        return response(200, [{ id: 54321, movie: { ids: { tmdb: 949 } } }]);
      },
    ],
  });

  const result = await trakt.syncWatch('watch-1');
  restoreEnv();

  assert.equal(result.synced, true);
  assert.equal(result.skipped, 'already_on_trakt');
  assert.deepEqual(requests.map((p) => p.split('?')[0]), [
    '/sync/history/movies',
    '/oauth/token',
    '/sync/history/movies',
  ]);
  assert(!requests.includes('/sync/history'));
  assert.equal(envUpdates[0].TRAKT_ACCESS_TOKEN, 'new-token');
});

test('syncWatch posts and captures history id when no existing Trakt play is found', async () => {
  const restoreEnv = withEnv({
    TRAKT_CLIENT_ID: 'client-id',
    TRAKT_ACCESS_TOKEN: 'access-token',
  });
  const pool = createPool(baseRow);
  const requests = [];
  const trakt = loadTrakt({
    pool,
    fetches: [
      (pathname) => {
        requests.push(pathname);
        return response(200, []);
      },
      (pathname, options) => {
        requests.push(pathname);
        assert.equal(pathname, '/sync/history');
        const body = JSON.parse(options.body);
        assert.equal(body.movies[0].ids.tmdb, 949);
        assert.equal(body.movies[0].watched_at, watchedAt);
        return response(201, { added: { movies: 1 }, not_found: { movies: [] } });
      },
      (pathname) => {
        requests.push(pathname);
        return response(200, [{ id: 67890, movie: { ids: { tmdb: 949 } } }]);
      },
    ],
  });

  const result = await trakt.syncWatch('watch-1');
  restoreEnv();

  assert.equal(result.synced, true);
  assert.equal(result.skipped, undefined);
  assert.deepEqual(requests.map((p) => p.split('?')[0]), [
    '/sync/history/movies',
    '/sync/history',
    '/sync/history/movies',
  ]);

  const update = pool.calls.find((call) => /trakt_synced_at = NOW\(\)/.test(call.sql));
  assert.deepEqual(update.params, ['watch-1', 67890]);
});

test('trakt-sync worker reports posted and already-on-Trakt rows separately', async () => {
  const { worker } = loadWorker({
    rows: [{ id: 'posted' }, { id: 'existing' }, { id: 'failed' }],
    results: [
      { synced: true },
      { synced: true, skipped: 'already_on_trakt' },
      { synced: false, error: 'failed' },
    ],
  });

  const result = await worker.runOnce();

  assert.deepEqual(result, {
    total: 3,
    synced: 2,
    posted: 1,
    alreadySynced: 1,
    failed: 1,
  });
});

test('trakt-sync worker can restrict a run to explicit watch ids', async () => {
  const watchIds = ['11111111-1111-1111-1111-111111111111'];
  const { worker, queries } = loadWorker({
    rows: [{ id: watchIds[0] }],
    results: [{ synced: true, skipped: 'already_on_trakt' }],
  });

  const result = await worker.runOnce({ watchIds });

  assert.equal(result.alreadySynced, 1);
  assert.match(queries[0].sql, /id = ANY\(\$2::uuid\[\]\)/);
  assert.deepEqual(queries[0].params, [8, watchIds]);
});
