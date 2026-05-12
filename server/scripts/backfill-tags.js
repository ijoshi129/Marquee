#!/usr/bin/env node
// One-shot backfill: for every watch row, regenerate the tags array from
// extractTags(title) + extractFormatsFromHtml() over every email_log row
// associated with it (reservation + thank-you). Idempotent — re-running
// just rewrites the same merged set.
//
// Run after migration 003 (or any time the format/tag extractors change):
//   docker exec marquee node scripts/backfill-tags.js

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });

const { pool } = require('../db');
const { extractTags, extractFormatsFromHtml } = require('../utils/normalize');

(async () => {
  const rows = (
    await pool.query(`SELECT id, title FROM watches ORDER BY created_at`)
  ).rows;
  console.log(`Backfilling tags for ${rows.length} watch row(s)`);

  let updated = 0;
  let unchanged = 0;
  for (const r of rows) {
    const fromTitle = extractTags(r.title);

    // Pull every email associated with this watch (reservation, thankyou,
    // cancellation). Cancellation usually has no format info but it's cheap
    // to include and lets the parser pick up anything AMC happens to emit.
    const emails = await pool.query(
      `SELECT raw_html FROM email_log WHERE watch_id = $1`,
      [r.id]
    );
    const fromHtml = emails.rows.flatMap((e) =>
      extractFormatsFromHtml(e.raw_html || '')
    );

    const merged = [...new Set([...fromTitle, ...fromHtml])];

    // Skip when nothing would change — preserves user-added custom tags
    // that aren't in this auto-extracted set. We only UPDATE when the
    // auto-extract differs from what's there.
    const current = (
      await pool.query(`SELECT tags FROM watches WHERE id = $1`, [r.id])
    ).rows[0].tags;
    const currentSet = new Set(current);
    const mergedAll = [...new Set([...current, ...merged])];
    const same = mergedAll.length === currentSet.size;
    if (same) {
      unchanged++;
      continue;
    }

    await pool.query(`UPDATE watches SET tags = $1 WHERE id = $2`, [mergedAll, r.id]);
    updated++;
    console.log(
      `  ${r.id.slice(0, 8)}  ${JSON.stringify(mergedAll).padEnd(36)} "${r.title}"`
    );
  }
  console.log(`Done — updated ${updated}, unchanged ${unchanged}`);
  await pool.end();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
