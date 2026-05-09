#!/usr/bin/env node
// Lists all available Gmail labels/folders and their message counts.

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const { ImapFlow } = require('imapflow');

(async () => {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    console.error('GMAIL_USER and GMAIL_APP_PASSWORD must be set');
    process.exit(2);
  }
  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user, pass },
    logger: false,
  });
  await client.connect();
  console.log(`Connected as ${user}\n`);
  console.log('Available labels/folders:');
  console.log('---');
  const list = await client.list();
  for (const m of list) {
    let count = '?';
    try {
      const status = await client.status(m.path, { messages: true });
      count = status.messages;
    } catch (err) {
      count = `(err: ${err.message})`;
    }
    console.log(`  ${m.path.padEnd(40)} ${String(count).padStart(6)} messages`);
  }
  console.log('---');
  console.log('\nIf "AMC" is missing or empty, you need to:');
  console.log('  1. Create a Gmail filter: from:(@amctheatres.com) → apply label "AMC"');
  console.log('  2. Open the AMC label in Gmail and "Apply to all conversations matching"');
  console.log('     (filter only applies to NEW mail unless you explicitly backfill)');
  await client.logout();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
