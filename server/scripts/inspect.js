const fs = require('fs');
const { simpleParser } = require('mailparser');
const cheerio = require('cheerio');

(async () => {
  const file = process.argv[2];
  const mail = await simpleParser(fs.readFileSync(file));
  console.log('SUBJECT:', mail.subject);
  console.log('---TEXT (first 2000 chars)---');
  console.log((mail.text || '').slice(0, 2000));
  console.log('---HEADINGS / styled big text---');
  const $ = cheerio.load(mail.html || '');
  $('h1, h2, h3, h4').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && t.length < 200) console.log('[' + el.tagName + ']', t);
  });
  $('[style]').each((_, el) => {
    const style = $(el).attr('style') || '';
    if (/font-size\s*:\s*(2[0-9]|3[0-9]|40)/i.test(style)) {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t && t.length < 200 && t.length > 1) console.log('[styled]', t.slice(0, 120));
    }
  });
  console.log('---SHORT TR text rows---');
  const seen = new Set();
  $('tr').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && t.length > 4 && t.length < 160 && !seen.has(t)) {
      seen.add(t);
      console.log('  ', t);
    }
  });
})();
