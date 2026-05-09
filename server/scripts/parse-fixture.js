#!/usr/bin/env node
// Usage: node scripts/parse-fixture.js path/to/email.eml
// Parses a saved RFC822 file (or HTML), runs classifier + the appropriate parser,
// prints the result. Used to iterate on selectors without IMAP credentials.

const fs = require('fs');
const path = require('path');
const { simpleParser } = require('mailparser');
const { classify } = require('../services/email-classify');
const reservationParser = require('../parsers/amc-reservation');
const thankyouParser = require('../parsers/amc-thankyou');
const cancellationParser = require('../parsers/amc-cancellation');

async function main() {
  const filepath = process.argv[2];
  if (!filepath) {
    console.error('Usage: node scripts/parse-fixture.js <path-to-email>');
    process.exit(2);
  }
  const raw = fs.readFileSync(path.resolve(filepath));
  const mail = await simpleParser(raw);
  const subject = mail.subject || '';
  const type = classify(subject);
  const html = mail.html || mail.textAsHtml || '';
  const text = mail.text || '';

  console.log(JSON.stringify({
    subject,
    from: mail.from?.text,
    received: mail.date,
    classified_as: type,
  }, null, 2));

  if (type === 'reservation') {
    console.log('--- reservation ---');
    console.log(JSON.stringify(reservationParser.parse({ subject, html, text }), null, 2));
  } else if (type === 'thankyou') {
    console.log('--- thankyou ---');
    console.log(JSON.stringify(thankyouParser.parse({ subject, html, text }), null, 2));
  } else if (type === 'cancellation') {
    console.log('--- cancellation ---');
    console.log(JSON.stringify(cancellationParser.parse({ subject, html, text }), null, 2));
  } else {
    console.log('--- all parsers (debug) ---');
    console.log('reservation:', JSON.stringify(reservationParser.parse({ subject, html, text }), null, 2));
    console.log('thankyou:', JSON.stringify(thankyouParser.parse({ subject, html, text }), null, 2));
    console.log('cancellation:', JSON.stringify(cancellationParser.parse({ subject, html, text }), null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
