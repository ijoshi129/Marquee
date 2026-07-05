const { pool } = require('../db');
const logger = require('../logger');
const { sendNtfy } = require('./ntfy');

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
  if (row) {
    sendPush(row).catch((err) => logger.error({ err }, 'push: send failed'));
    sendNtfy(row).catch((err) => logger.error({ err }, 'ntfy: send failed'));
  }
  return row;
}

// Best-effort Web Push to every stored subscription. No-ops until VAPID keys are
// set and the `web-push` package is installed (added with the push feature).
async function sendPush(notif) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  let webpush;
  try {
    webpush = require('web-push');
  } catch {
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
  await Promise.all(
    rows.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          body
        );
      } catch (err) {
        // 404/410 mean the subscription is dead — prune it.
        if (err.statusCode === 404 || err.statusCode === 410) {
          await pool.query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]);
        } else {
          logger.error({ status: err.statusCode }, 'push: delivery error');
        }
      }
    })
  );
}

module.exports = { notify, sendPush };
