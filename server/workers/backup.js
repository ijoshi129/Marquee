// Daily Postgres dump → gzipped file in BACKUP_DIR. Old files are pruned
// past BACKUP_RETENTION_DAYS so the volume doesn't grow unboundedly.
//
// Disabled when BACKUP_DIR is unset. Requires `pg_dump` on PATH (the
// Marquee Dockerfile installs `postgresql16-client`).

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const cron = require('node-cron');
const logger = require('../logger');

const BACKUP_DIR = process.env.BACKUP_DIR || '';
const RETENTION_DAYS = parseInt(process.env.BACKUP_RETENTION_DAYS || '30', 10);
const FILE_PREFIX = 'marquee-';
const FILE_RE = /^marquee-\d{4}-\d{2}-\d{2}\.sql\.gz$/;

function ensureDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

async function runBackup() {
  if (!BACKUP_DIR) return null;
  ensureDir();

  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(BACKUP_DIR, `${FILE_PREFIX}${today}.sql.gz`);

  return await new Promise((resolve, reject) => {
    const dump = spawn(
      'pg_dump',
      [
        '--no-owner',
        '--no-privileges',
        '--clean',
        '--if-exists',
        process.env.DATABASE_URL,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    const gzip = spawn('gzip', ['-9'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const out = fs.createWriteStream(outPath);

    let dumpErr = '';
    dump.stderr.on('data', (chunk) => { dumpErr += chunk.toString(); });
    dump.stdout.pipe(gzip.stdin);
    gzip.stdout.pipe(out);

    dump.on('error', reject);
    gzip.on('error', reject);
    out.on('error', reject);

    out.on('finish', () => {
      // pg_dump exit code is observed via close, not the writable stream.
    });

    dump.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`pg_dump exit ${code}: ${dumpErr.trim()}`));
      }
    });

    gzip.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`gzip exit ${code}`));
      }
      try {
        const size = fs.statSync(outPath).size;
        logger.info(
          { file: outPath, size_bytes: size },
          `backup written (${(size / 1024).toFixed(1)} KB)`
        );
        pruneOld();
        resolve(outPath);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function pruneOld() {
  if (!BACKUP_DIR || !fs.existsSync(BACKUP_DIR)) return 0;
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  let pruned = 0;
  for (const file of fs.readdirSync(BACKUP_DIR)) {
    if (!FILE_RE.test(file)) continue;
    const full = path.join(BACKUP_DIR, file);
    const stat = fs.statSync(full);
    if (stat.mtimeMs < cutoff) {
      fs.unlinkSync(full);
      pruned++;
    }
  }
  if (pruned > 0) {
    logger.info({ pruned, retention_days: RETENTION_DAYS }, `pruned ${pruned} old backup(s)`);
  }
  return pruned;
}

let task = null;
function start() {
  if (!BACKUP_DIR) {
    logger.info('backup: BACKUP_DIR not set — automated backups disabled');
    return null;
  }
  logger.info(
    { backup_dir: BACKUP_DIR, retention_days: RETENTION_DAYS },
    'backup: starting (daily at 03:30)'
  );
  task = cron.schedule('30 3 * * *', () =>
    runBackup().catch((err) => logger.error({ err }, 'backup failed'))
  );
  return task;
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, runBackup, pruneOld };
