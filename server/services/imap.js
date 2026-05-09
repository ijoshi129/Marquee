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
async function fetchAmcMessages({ since } = {}) {
  const folder = process.env.GMAIL_LABEL || '[Gmail]/All Mail';
  const fromFilter = process.env.GMAIL_AMC_FROM || 'amctheatres.com';

  const client = makeClient();
  await client.connect();
  const out = [];
  try {
    const lock = await client.getMailboxLock(folder);
    try {
      const search = {
        from: fromFilter,
        since: since || new Date('2000-01-01'),
      };
      const uids = await client.search(search, { uid: true });
      if (!uids || !uids.length) {
        logger.info(`imap: 0 messages from "${fromFilter}" in "${folder}" since ${search.since.toISOString()}`);
        return [];
      }
      logger.info(`imap: ${uids.length} messages from "${fromFilter}" in "${folder}"`);

      for await (const msg of client.fetch(
        uids,
        { uid: true, source: true, internalDate: true, envelope: true },
        { uid: true }
      )) {
        const id = msg.envelope?.messageId || `uid-${msg.uid}`;
        out.push({
          gmail_message_id: id,
          received_at: msg.internalDate || new Date(),
          source: msg.source,
          subject: msg.envelope?.subject || '',
          from: msg.envelope?.from?.[0]?.address || '',
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
