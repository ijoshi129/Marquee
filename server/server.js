require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const pinoHttp = require('pino-http');
const path = require('path');

const logger = require('./logger');
const { pool, initSchema, runMigrations } = require('./db');
const watches = require('./routes/watches');
const stats = require('./routes/stats');
const tmdbRoute = require('./routes/tmdb');
const theaters = require('./routes/theaters');
const admin = require('./routes/admin');
const searchSuggest = require('./routes/search-suggest');
const exportRoute = require('./routes/export');
const tagsRoute = require('./routes/tags');
const emailPoller = require('./workers/email-poller');
const pendingExpirer = require('./workers/pending-expirer');
const backup = require('./workers/backup');

const app = express();
const PORT = process.env.PORT || 3000;

// Security headers. CSP is disabled — getting it right with Vite's bundled
// modules + inline styles + Google Fonts + service worker fetches is fiddly,
// and on a Tailscale-only LAN it adds little. Re-enable once exposed publicly.
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// One-line-per-request structured access log.
app.use(
  pinoHttp({
    logger,
    customLogLevel: (req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      // Don't pollute logs with 200s on health checks.
      if (req.url === '/health' || req.url === '/api/health') return 'silent';
      return 'info';
    },
    autoLogging: true,
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ status: res.statusCode }),
    },
  })
);

// Generous rate limit: 600 req/min per IP. Personal-app scale; protects
// against runaway scripts more than malicious traffic.
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.path === '/health',
  })
);

app.use(cors({ origin: process.env.CLIENT_URL || 'http://localhost:5173' }));
app.use(express.json({ limit: '1mb' }));

async function healthHandler(req, res) {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'ok',
      db: 'connected',
      uptime_seconds: Math.round(process.uptime()),
    });
  } catch (err) {
    res.status(503).json({
      status: 'degraded',
      db: 'unreachable',
      error: err.message,
    });
  }
}
app.get('/health', healthHandler);
app.get('/api/health', healthHandler);

app.use('/api/watches', watches);
app.use('/api/stats', stats);
app.use('/api/tmdb', tmdbRoute);
app.use('/api/theaters', theaters);
app.use('/api/admin', admin);
app.use('/api/search-suggest', searchSuggest);
app.use('/api/export', exportRoute);
app.use('/api/tags', tagsRoute);

// Serve client build in production
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(
  express.static(clientDist, {
    setHeaders: (res, filePath) => {
      // The service worker MUST be revalidated on every load — otherwise
      // Safari/iOS sticks to the cached copy and never picks up bumped
      // VERSION constants. The hashed assets (under /assets/) are
      // content-addressed and safe to cache for a long time.
      if (filePath.endsWith('sw.js')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      } else if (filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    },
  })
);
app.get(/^\/(?!api\/|health$).*/, (req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'), (err) => {
    if (err) res.status(404).end();
  });
});

(async () => {
  try {
    await pool.query('SELECT 1');
    logger.info('Postgres connected');
    await initSchema();
    await runMigrations();
    logger.info('Schema ready');
    const server = app.listen(PORT, () =>
      logger.info({ port: PORT }, `Marquee server on http://localhost:${PORT}`)
    );

    emailPoller.start();
    pendingExpirer.start();
    backup.start();

    const shutdown = async (sig) => {
      logger.info({ signal: sig }, `${sig} received, shutting down`);
      emailPoller.stop();
      pendingExpirer.stop();
      backup.stop();
      server.close(() => pool.end().then(() => process.exit(0)));
      setTimeout(() => process.exit(1), 10_000).unref();
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err) {
    logger.error({ err }, 'Startup failed');
    process.exit(1);
  }
})();
