const { ImapFlow } = require('imapflow');
const logger = require('../logger');

function makeClient() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) throw new Error('GMAIL_USER and GMAIL_APP_PASSWORD must be set');
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

// Fetch raw RFC822 sources for AMC messages.
//
// By default searches `[Gmail]/All Mail` for `from:@amctheatres.com` — works without
// needing the user to maintain a Gmail label/filter. If GMAIL_LABEL is set explicitly,
// uses that folder instead (still applying the from filter as a defensive measure).
//
// Returns array of { gmail_message_id, received_at, source } sorted ascending.
async function fetchAmcMessages({ since, knownIds } = {}) {
  const folder = process.env.GMAIL_LABEL || '[Gmail]/All Mail';
  const fromFilter = process.env.GMAIL_AMC_FROM || 'amctheatres.com';

  const client = makeClient();
  await client.connect();
  const out = [];
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      // UIDs are only unique within a mailbox's current UIDVALIDITY. Fold it into
      // the synthetic fallback id so a UIDVALIDITY change can't collide keys.
      const uidValidity = client.mailbox?.uidValidity ?? 'na';
      const search = {
        from: fromFilter,
        since: since || new Date('2000-01-01'),
      };
      const uids = await client.search(search, { uid: true });
      if (!uids || !uids.length) {
        logger.info(`imap: 0 messages from "${fromFilter}" in "${folder}" since ${search.since.toISOString()}`);
        return [];
      }

      // Pass 1: cheap envelope-only fetch to compute ids and drop messages we've
      // already stored, so we don't re-download full source bytes every cycle.
      const meta = [];
      for await (const msg of client.fetch(
        uids,
        { uid: true, internalDate: true, envelope: true },
        { uid: true }
      )) {
        meta.push({
          uid: msg.uid,
          id: msg.envelope?.messageId || `uid-${uidValidity}-${msg.uid}`,
          received_at: msg.internalDate || new Date(),
          subject: msg.envelope?.subject || '',
          from: msg.envelope?.from?.[0]?.address || '',
        });
      }
      const fresh = knownIds ? meta.filter((m) => !knownIds.has(m.id)) : meta;
      logger.info(
        `imap: ${uids.length} messages from "${fromFilter}" in "${folder}", ${fresh.length} new`
      );
      if (!fresh.length) return [];

      // Pass 2: fetch full source only for the genuinely new messages.
      const sources = new Map();
      for await (const msg of client.fetch(
        fresh.map((m) => m.uid),
        { uid: true, source: true },
        { uid: true }
      )) {
        sources.set(msg.uid, msg.source);
      }
      for (const m of fresh) {
        out.push({
          gmail_message_id: m.id,
          received_at: m.received_at,
          source: sources.get(m.uid),
          subject: m.subject,
          from: m.from,
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }
  out.sort((a, b) => a.received_at - b.received_at);
  return out;
}

module.exports = { fetchAmcMessages };
