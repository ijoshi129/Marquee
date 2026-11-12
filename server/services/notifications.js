const { pool } = require('../db');
const logger = require('../logger');
const { sendNtfy, shouldSend } = require('./ntfy');
const jobStatus = require('./job-status');

// Create a notification (deduped by dedupe_key) and fan it out to whatever
// push channels are configured (Web Push, ntfy). Returns the new row, or null
// if it was a duplicate.
async function notify({ kind, title, body = null, payload = {}, dedupeKey = null }) {
  const { rows } = await pool.query(
    `INSERT INTO notifications (kind, title, body, payload, dedupe_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, kind, title, body, payload, created_at`,
    [kind, title, body, payload, dedupeKey]
  );
  const row = rows[0] || null;
  if (row && (await shouldSend(row.kind).catch(() => true))) {
    sendPush(row).catch((err) => logger.error({ err }, 'push: send failed'));
    sendNtfy(row).catch((err) => logger.error({ err }, 'ntfy: send failed'));
  }
  return row;
}

// Best-effort Web Push to every stored subscription. No-ops until VAPID keys are
// set.
async function sendPush(notif) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  let webpush;
  try {
    // web-push 4 is ESM-only, and require() of an ES module needs Node 20.19,
    // 22.12 or later. On anything older this throws: say so rather than drop
    // every push without a word.
    webpush = require('web-push');
  } catch (err) {
    logger.error({ err }, 'push: could not load web-push');
    await jobStatus.failed('push', `Could not load web-push (${err.code || err.message})`);
    return;
  }
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:marquee@localhost',
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
  const { rows } = await pool.query('SELECT * FROM push_subscriptions');
  const body = JSON.stringify({
    title: notif.title,
    body: notif.body || '',
    kind: notif.kind,
    url: '/',
  });
  let delivered = 0;
  let lastError = null;
  await Promise.all(
    rows.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body
        );
        delivered++;
      } catch (err) {
        // 404/410 mean the subscription is dead — prune it.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        } else {
          logger.error({ status: err.statusCode }, 'push: delivery error');
          lastError = err;
        }
      }
    })
  );
  // A dead subscription being pruned is housekeeping, not a failure; only a
  // send where nothing got through and something errored counts as one.
  if (delivered) await jobStatus.succeeded('push', { devices: rows.length, delivered });
  else if (lastError) await jobStatus.failed('push', `Push service refused (HTTP ${lastError.statusCode || '?'})`);
}

module.exports = { notify, sendPush };
