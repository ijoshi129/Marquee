// Hourly: tell the owner about any background job that has been failing, or
// has gone quiet, for over a day. The Status sheet shows the same thing, but
// only to someone who thinks to open it.

const cron = require('node-cron');
const logger = require('../logger');
const status = require('../services/status');
const notifications = require('../services/notifications');

async function checkOnce() {
  try {
    await status.watchEnabled();
    for (const alert of await status.dueAlerts()) {
      // Deduped on when the trouble began, so each outage is announced once.
      await notifications.notify({
        kind: 'status',
        title: alert.title,
        body: alert.body,
        payload: { status: alert.key },
        dedupeKey: alert.dedupeKey,
      });
    }
  } catch (err) {
    logger.error({ err }, 'status-monitor: check failed');
  }
}

let task = null;
function start() {
  logger.info('status-monitor: starting (hourly)');
  status.watchEnabled().catch((err) => logger.error({ err }, 'status-monitor: watch failed'));
  task = cron.schedule('20 * * * *', checkOnce);
  return task;
}

function stop() {
  if (task) task.stop();
}

module.exports = { start, stop, checkOnce };
