const { pool } = require('../db');
const { fetchWithTimeout } = require('./http');
const logger = require('../logger');

const SEND_TIMEOUT_MS = 5000;

// Which notification kinds map to which settings toggle and ntfy tag (emoji).
// Kinds without an entry (e.g. friend_added) always send when ntfy is on.
const KINDS = {
  comment: { column: 'notify_comment', tags: ['speech_balloon'] },
  recommend: { column: 'notify_recommend', tags: ['envelope_with_arrow'] },
  together: { column: 'notify_together', tags: ['popcorn'] },
  booked: { column: 'notify_booked', tags: ['tickets'] },
};

async function getSettings() {
  // Row is seeded by migration 016; the ensure-insert is only a safety net.
  const { rows } = await pool.query(`SELECT * FROM ntfy_settings WHERE id = TRUE`);
  if (rows[0]) return rows[0];
  await pool.query(`INSERT INTO ntfy_settings (id) VALUES (TRUE) ON CONFLICT (id) DO NOTHING`);
  return (await pool.query(`SELECT * FROM ntfy_settings WHERE id = TRUE`)).rows[0];
}

const FIELDS = ['enabled', 'server_url', 'topic', 'token', 'notify_comment', 'notify_recommend', 'notify_together', 'notify_booked'];

async function updateSettings(body) {
  const updates = [];
  const params = [];
  for (const f of FIELDS) {
    if (f in body) {
      // Blank strings clear a field — except server_url, which is NOT NULL;
      // clearing it falls back to the default instead of erroring.
      let v = body[f] === '' ? null : body[f];
      if (f === 'server_url' && !v) v = 'https://ntfy.sh';
      params.push(v);
      updates.push(`${f} = $${params.length}`);
    }
  }
  if (!updates.length) return getSettings();
  const { rows } = await pool.query(
    `UPDATE ntfy_settings SET ${updates.join(', ')}, updated_at = NOW() WHERE id = TRUE RETURNING *`,
    params
  );
  return rows[0] || getSettings();
}

// Publish one message. Uses ntfy's JSON endpoint (POST to the server root) so
// film titles with non-ASCII characters survive — the header style mangles them.
async function publish(settings, { title, message, tags = [] }) {
  const server = (settings.server_url || '').replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json' };
  if (settings.token) headers.authorization = `Bearer ${settings.token}`;
  const resp = await fetchWithTimeout(server, {
    method: 'POST',
    headers,
    body: JSON.stringify({ topic: settings.topic, title, message, tags }),
  }, SEND_TIMEOUT_MS);
  if (!resp.ok) {
    const body = await resp.json().catch(() => ({}));
    throw new Error(body.error || `ntfy returned HTTP ${resp.status}`);
  }
}

// Best-effort fan-out of an app notification. No-ops until the owner has
// enabled ntfy and set a topic; per-kind toggles filter what gets through.
async function sendNtfy(notif) {
  let settings;
  try {
    settings = await getSettings();
  } catch {
    return;
  }
  if (!settings.enabled || !settings.server_url || !settings.topic) return;
  const kind = KINDS[notif.kind];
  try {
    await publish(settings, {
      title: notif.title,
      message: notif.body || '',
      tags: kind ? kind.tags : ['clapper'],
    });
  } catch (err) {
    logger.error({ err }, 'ntfy: send failed');
  }
}

// Used by the settings UI's Test button: send with the given (unsaved) values
// and surface the failure reason instead of swallowing it.
async function sendTest(settings) {
  if (!settings.server_url || !settings.topic) {
    throw new Error('Server URL and topic are required');
  }
  await publish(settings, {
    title: 'Marquee test',
    message: 'ntfy is wired up.',
    tags: ['clapper'],
  });
}

// Whether the owner wants alerts of this kind sent to their devices at all —
// consulted by every outbound channel (ntfy here, Web Push in notifications.js).
// The in-app bell always records regardless.
async function shouldSend(kind) {
  const k = KINDS[kind];
  if (!k) return true;
  try {
    const settings = await getSettings();
    return settings[k.column] !== false;
  } catch {
    return true;
  }
}

module.exports = { getSettings, updateSettings, sendNtfy, sendTest, shouldSend };
