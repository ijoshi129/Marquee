// Structured logging via pino.
//
// In production, logs are JSON one-line-per-record so they pipe cleanly into
// docker logs / Loki / a pager. In development (NODE_ENV !== 'production')
// they're pretty-printed for human eyes.
//
// Override the level with LOG_LEVEL=debug|info|warn|error.

const pino = require('pino');

const isProd = process.env.NODE_ENV === 'production';

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  base: { app: 'marquee' },
  timestamp: pino.stdTimeFunctions.isoTime,
  ...(isProd
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss',
            ignore: 'pid,hostname,app',
          },
        },
      }),
});

module.exports = logger;
