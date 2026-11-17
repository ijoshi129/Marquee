// Runs the Now Playing alerts: watched showings every ten minutes, Unseens
// going on sale every three hours, and new films once a day.

const cron = require('node-cron');
const logger = require('../logger');
const alerts = require('../services/now-playing-alerts');
const jobStatus = require('../services/job-status');

async function run(name, fn) {
  try {
    const out = await fn();
    if (out && out.error) {
      await jobStatus.failed('alerts', out.error);
    } else {
      await jobStatus.succeeded('alerts', { last: name, ...out });
    }
    return out;
  } catch (err) {
    logger.error({ err }, `now-playing-alerts: ${name} failed`);
    await jobStatus.failed('alerts', err);
    return null;
  }
}

const tasks = [];
function start() {
  logger.info('now-playing-alerts: starting (watched showings every 10 minutes, Unseens every 3 hours, new films daily)');
  tasks.push(cron.schedule('*/10 * * * *', () => run('watching', () => alerts.checkWatching())));
  tasks.push(cron.schedule('25 */3 * * *', () => run('unseens', () => alerts.checkUnseens())));
  // Mid-morning on the US east coast, after the day's listings have settled.
  tasks.push(cron.schedule('10 15 * * *', () => run('new films', () => alerts.checkNewFilms())));
  return tasks;
}

function stop() {
  for (const t of tasks) t.stop();
  tasks.length = 0;
}

module.exports = { start, stop, run };
