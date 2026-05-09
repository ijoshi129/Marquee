const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const logger = require('./logger');

// If DATABASE_URL isn't explicitly set, construct it from the POSTGRES_*
// vars so users only have to maintain a single password. The docker-compose
// stack overrides DATABASE_URL to point at the internal `postgres` service;
// this fallback is for dev mode (npm run dev on the host).
function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
  const user = process.env.POSTGRES_USER || 'marqueeadmin';
  const pass = process.env.POSTGRES_PASSWORD;
  const db = process.env.POSTGRES_DB || 'marquee';
  const host = process.env.POSTGRES_HOST || 'localhost';
  const port =
    process.env.POSTGRES_PORT || process.env.POSTGRES_HOST_PORT || 5433;
  if (!pass) {
    throw new Error(
      'POSTGRES_PASSWORD is required (or set DATABASE_URL explicitly)'
    );
  }
  process.env.DATABASE_URL = `postgresql://${user}:${encodeURIComponent(
    pass
  )}@${host}:${port}/${db}`;
}
ensureDatabaseUrl();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

pool.on('error', (err) => {
  logger.error({ err }, 'Postgres pool error');
});

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

// Baseline schema — idempotent. Always safe to run on every boot. New changes
// past this point go in numbered SQL files under server/migrations/ and are
// applied by runMigrations() below.
async function initSchema() {
  await pool.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS theaters (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      normalized_name TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS tmdb_cache (
      tmdb_id INTEGER PRIMARY KEY,
      payload JSONB NOT NULL,
      fetched_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS watches (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      tmdb_id INTEGER REFERENCES tmdb_cache(tmdb_id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      showtime TIMESTAMPTZ,
      theater_id INTEGER REFERENCES theaters(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'watched'
        CHECK (status IN ('pending', 'watched', 'no_show', 'cancelled')),
      source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('amc_email', 'manual')),
      rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
      notes TEXT,
      tmdb_needs_review BOOLEAN NOT NULL DEFAULT FALSE,
      reservation_email_id TEXT,
      thankyou_email_id TEXT,
      order_number TEXT,
      watched_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE watches ADD COLUMN IF NOT EXISTS order_number TEXT`);
  // `acknowledged` is intentionally a single bool that doubles as the
  // "notification needs your attention" flag for ALL notification flavors:
  //   - status='no_show' or 'cancelled' → "were you there?" prompt
  //   - status='pending' aged 7-30d     → "did you go or miss it?" prompt
  //   - Screen Unseen with no tmdb_id   → "identify the movie" prompt
  // Setting acknowledged=TRUE clears the row from /api/watches/notifications.
  // Tech debt: if the notification surface ever needs per-kind state (e.g.
  // dismissed-but-still-show, or ack history), this will need to graduate
  // to a separate notifications table.
  await pool.query(
    `ALTER TABLE watches ADD COLUMN IF NOT EXISTS acknowledged BOOLEAN NOT NULL DEFAULT TRUE`
  );

  await pool.query(`CREATE INDEX IF NOT EXISTS idx_watches_status ON watches(status)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_watches_watched_at ON watches(watched_at DESC)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_watches_showtime ON watches(showtime)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_watches_order_number ON watches(order_number)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_watches_thankyou_email_id ON watches(thankyou_email_id) WHERE thankyou_email_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_watches_reservation_email_id ON watches(reservation_email_id) WHERE reservation_email_id IS NOT NULL`);
  await pool.query(`CREATE INDEX IF NOT EXISTS idx_watches_unacknowledged ON watches(updated_at DESC) WHERE acknowledged = FALSE`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_log (
      gmail_message_id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('reservation', 'thankyou', 'cancellation', 'unknown')),
      received_at TIMESTAMPTZ NOT NULL,
      parsed_at TIMESTAMPTZ,
      parse_status TEXT NOT NULL DEFAULT 'pending'
        CHECK (parse_status IN ('pending', 'ok', 'failed')),
      parse_error TEXT,
      raw_html TEXT,
      watch_id UUID REFERENCES watches(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`ALTER TABLE email_log DROP CONSTRAINT IF EXISTS email_log_type_check`);
  await pool.query(`
    ALTER TABLE email_log
    ADD CONSTRAINT email_log_type_check
    CHECK (type IN ('reservation', 'thankyou', 'cancellation', 'unknown'))
  `);
}

// Numbered SQL migrations applied after the baseline. Each file is run once
// per database (tracked in `_migrations`). Ordered alphabetically — name
// new files NNN_short_description.sql with a 3-digit prefix.
async function runMigrations() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) return;

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const filename of files) {
    const exists = await pool.query(
      'SELECT 1 FROM _migrations WHERE filename = $1',
      [filename]
    );
    if (exists.rowCount > 0) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
    logger.info({ filename }, `Running migration ${filename}`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (filename) VALUES ($1)', [filename]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ err, filename }, `Migration ${filename} failed`);
      throw err;
    } finally {
      client.release();
    }
  }
}

module.exports = { pool, initSchema, runMigrations };
