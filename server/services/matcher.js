// Pending → Watched matcher. See plan §"Pending → Watched Matching Algorithm".

const { pool } = require('../db');
const logger = require('../logger');
const { normalizeText, cleanTitle } = require('../utils/normalize');
const tmdb = require('./tmdb');
const unseenLookup = require('./unseen-lookup');
const { upsertTheater } = require('./theaters');
const trakt = require('./trakt');

const normTitle = (t) => normalizeText(cleanTitle(t));

// AMC sends thank-you emails 1–4 days after the show (sometimes never). The
// before-window has to cover that range or late thank-yous miss the pending /
// auto-watched row and the matcher creates a duplicate walk-up. 4 days lines
// up with NEEDS_CONFIRM_DAYS in pending-expirer.
const WINDOW_BEFORE_HOURS = 24 * 4;
const WINDOW_AFTER_HOURS = 1;
const TIEBREAKER_OFFSET_HOURS = 2; // typical post-show email delay

// Insert a new pending watch row from a parsed reservation.
async function ingestReservation({ fields, gmail_message_id }) {
  const { title, theater_name, showtime, order_number, tags: parsedTags } = fields;
  const theater = await upsertTheater(theater_name);

  // Idempotency: same reservation email or same order_number.
  const existing = await pool.query(
    `SELECT id FROM watches
     WHERE reservation_email_id = $1
        OR (order_number IS NOT NULL AND order_number = $2)
     LIMIT 1`,
    [gmail_message_id, order_number]
  );
  if (existing.rows.length) {
    return { watch_id: existing.rows[0].id, deduped: true };
  }

  // TMDB enrichment up front so pending shows have posters in the grid.
  let tmdbId = null;
  let needsReview = false;
  try {
    const m = await tmdb.autoMatch(title, { year: tmdb.yearOf(showtime) });
    if (m) {
      tmdbId = m.tmdb_id;
      needsReview = m.needs_review;
    } else {
      needsReview = true;
    }
  } catch (err) {
    logger.error({ err: err }, 'TMDB enrichment failed during reservation ingest (non-fatal)');
    needsReview = true;
  }

  const tags = Array.isArray(parsedTags) ? parsedTags : [];

  const insert = await pool.query(
    `INSERT INTO watches
       (tmdb_id, title, theater_id, showtime, status, source,
        reservation_email_id, order_number, tmdb_needs_review, tags)
     VALUES ($1, $2, $3, $4, 'pending', 'amc_email', $5, $6, $7, $8)
     RETURNING id`,
    [tmdbId, title, theater?.id || null, showtime, gmail_message_id, order_number || null, needsReview, tags]
  );
  return { watch_id: insert.rows[0].id, deduped: false };
}

// Mark a pending watch as 'cancelled' based on its order_number.
async function ingestCancellation({ fields, gmail_message_id }) {
  const { order_number } = fields;
  if (!order_number) return { action: 'orphan', watch_id: null };

  const r = await pool.query(
    `UPDATE watches
     SET status = 'cancelled', acknowledged = FALSE, updated_at = NOW()
     WHERE order_number = $1 AND status = 'pending'
     RETURNING id`,
    [order_number]
  );

  if (r.rows.length) {
    return { action: 'cancelled', watch_id: r.rows[0].id };
  }
  // No matching pending row. Could be a reservation we never saw — log and move on.
  logger.info(`cancellation: no pending watch found for order_number=${order_number}`);
  return { action: 'orphan', watch_id: null };
}

// Match a parsed Thank You against pending watches.
// Returns { action: 'promoted' | 'walkup' | 'deduped', watch_id, candidates: number }.
async function ingestThankyou({ fields, gmail_message_id, received_at }) {
  // Idempotency: same Thank You email already processed.
  const existing = await pool.query(
    `SELECT id FROM watches WHERE thankyou_email_id = $1 LIMIT 1`,
    [gmail_message_id]
  );
  if (existing.rows.length) {
    return { action: 'deduped', watch_id: existing.rows[0].id, candidates: 0 };
  }

  const { title, theater_name } = fields;
  const normTheater = normalizeText(theater_name);
  const normTit = normTitle(title);
  const recv = received_at instanceof Date ? received_at : new Date(received_at);
  const before = new Date(recv.getTime() - WINDOW_BEFORE_HOURS * 3600_000);
  const after = new Date(recv.getTime() + WINDOW_AFTER_HOURS * 3600_000);

  // Candidates: still-pending rows (typical case, thank-you arrives within
  // hours of showtime) AND auto-watched rows that haven't been linked to a
  // thank-you yet (the pending-expirer flipped them at showtime+24h before
  // the thank-you arrived — without this clause we'd create a duplicate
  // walk-up row).
  const candidates = await pool.query(
    `SELECT w.id, w.showtime, w.title, w.status, t.normalized_name AS norm_theater
     FROM watches w
     LEFT JOIN theaters t ON t.id = w.theater_id
     WHERE w.showtime BETWEEN $1 AND $2
       AND (
         w.status = 'pending'
         OR (w.status = 'watched' AND w.thankyou_email_id IS NULL)
       )`,
    [before.toISOString(), after.toISOString()]
  );

  const filtered = candidates.rows.filter(
    (r) => r.norm_theater === normTheater && normTitle(r.title) === normTit
  );

  let chosen = null;
  if (filtered.length === 1) {
    chosen = filtered[0];
  } else if (filtered.length > 1) {
    // Tiebreaker: pick showtime closest to (received_at - 2h).
    const target = new Date(recv.getTime() - TIEBREAKER_OFFSET_HOURS * 3600_000).getTime();
    chosen = filtered
      .map((r) => ({ ...r, _delta: Math.abs(new Date(r.showtime).getTime() - target) }))
      .sort((a, b) => a._delta - b._delta)[0];
  }

  if (chosen) {
    // Thank-you emails are the typical carrier for <img alt="..."> format
    // badges (BigD, RealD 3D, etc.). Merge those into the row's existing
    // tags so we don't lose anything that arrived only in this email.
    const incomingTags = Array.isArray(fields.tags) ? fields.tags : [];
    if (chosen.status === 'pending') {
      // Standard promote: status flip plus watched_at = thank-you receive time
      // (best available proxy for actual watch time).
      await pool.query(
        `UPDATE watches
         SET status = 'watched',
             watched_at = $1,
             thankyou_email_id = $2,
             tags = COALESCE(
               (
                 SELECT array_agg(DISTINCT t)
                 FROM unnest(coalesce(tags, '{}'::text[]) || $4::text[]) AS t
               ),
               '{}'::text[]
             ),
             updated_at = NOW()
         WHERE id = $3`,
        [recv.toISOString(), gmail_message_id, chosen.id, incomingTags]
      );
    } else {
      // Already auto-watched by pending-expirer step 1. Link the thank-you,
      // preserve the existing watched_at (set from showtime, more accurate
      // than the email receive time), and force-ack so any "did you go?"
      // bulletin item raised by pending-expirer step 2 disappears.
      await pool.query(
        `UPDATE watches
         SET thankyou_email_id = $1,
             acknowledged = TRUE,
             tags = COALESCE(
               (
                 SELECT array_agg(DISTINCT t)
                 FROM unnest(coalesce(tags, '{}'::text[]) || $3::text[]) AS t
               ),
               '{}'::text[]
             ),
             updated_at = NOW()
         WHERE id = $2`,
        [gmail_message_id, chosen.id, incomingTags]
      );
    }
    // Enrich via TMDB if not yet enriched
    await ensureTmdb(chosen.id, title);
    trakt.queueWatch(chosen.id).catch((err) => {
      logger.error({ err, watch_id: chosen.id }, 'trakt queue failed (non-fatal)');
    });
    maybeResolveUnseen(chosen.id, chosen.title || title);
    return {
      action: chosen.status === 'pending' ? 'promoted' : 'linked',
      watch_id: chosen.id,
      candidates: filtered.length,
    };
  }

  // Walk-up: no matching reservation. Create a new watched row.
  const theater = await upsertTheater(theater_name);
  let tmdbId = null;
  let needsReview = true;
  try {
    const m = await tmdb.autoMatch(title, { year: tmdb.yearOf(recv) });
    if (m) {
      tmdbId = m.tmdb_id;
      needsReview = m.needs_review;
    }
  } catch (err) {
    logger.error({ err: err }, 'TMDB enrichment failed during walk-up (non-fatal)');
  }

  const tags = Array.isArray(fields.tags) ? fields.tags : [];

  const insert = await pool.query(
    `INSERT INTO watches
       (tmdb_id, title, theater_id, status, source,
        thankyou_email_id, watched_at, tmdb_needs_review, tags)
     VALUES ($1, $2, $3, 'watched', 'amc_email', $4, $5, $6, $7)
     RETURNING id`,
    [tmdbId, title, theater?.id || null, gmail_message_id, recv.toISOString(), needsReview, tags]
  );

  maybeResolveUnseen(insert.rows[0].id, title);
  trakt.queueWatch(insert.rows[0].id).catch((err) => {
    logger.error({ err, watch_id: insert.rows[0].id }, 'trakt queue failed (non-fatal)');
  });
  return { action: 'walkup', watch_id: insert.rows[0].id, candidates: 0 };
}

// Fire-and-forget: if this watch is an AMC Screen/Scream Unseen, ask the Reddit
// megathread parser to resolve the actual movie. If the lookup can't figure it
// out (Reddit unreachable, no megathread entry, etc.), flip the watch into the
// notifications panel so the user can identify it manually. Errors are logged
// but never thrown — the matcher path must not fail because of this lookup.
function maybeResolveUnseen(watch_id, title) {
  if (!/AMC\s+(?:Screen|Scream)\s+Unseen/i.test(title || '')) return;
  unseenLookup
    .resolveAndAssign(watch_id)
    .then((result) => {
      if (!result || !result.resolved) {
        return flagForManualIdentification(watch_id);
      }
    })
    .catch((err) => {
      logger.error({ err: err }, 'unseen-lookup failed (non-fatal)');
      return flagForManualIdentification(watch_id);
    });
}

async function flagForManualIdentification(watch_id) {
  try {
    await pool.query(
      `UPDATE watches
       SET acknowledged = FALSE, updated_at = NOW()
       WHERE id = $1 AND tmdb_id IS NULL`,
      [watch_id]
    );
  } catch (err) {
    logger.error({ err: err }, 'flag-for-manual-id failed');
  }
}

async function ensureTmdb(watch_id, title) {
  const cur = await pool.query(
    'SELECT tmdb_id, showtime, watched_at FROM watches WHERE id = $1',
    [watch_id]
  );
  if (!cur.rows.length || cur.rows[0].tmdb_id) return;
  try {
    const { showtime, watched_at } = cur.rows[0];
    const m = await tmdb.autoMatch(title, { year: tmdb.yearOf(showtime || watched_at) });
    if (m) {
      await pool.query(
        'UPDATE watches SET tmdb_id = $1, tmdb_needs_review = $2, updated_at = NOW() WHERE id = $3',
        [m.tmdb_id, m.needs_review, watch_id]
      );
    } else {
      await pool.query(
        'UPDATE watches SET tmdb_needs_review = TRUE, updated_at = NOW() WHERE id = $1',
        [watch_id]
      );
    }
  } catch (err) {
    logger.error({ err: err }, 'TMDB enrichment failed (non-fatal)');
  }
}

module.exports = { ingestReservation, ingestThankyou, ingestCancellation };
