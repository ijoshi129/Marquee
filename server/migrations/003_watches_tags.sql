-- Per-watch user tags. Auto-extracted on AMC ingest from the email title
-- (RealD 3D, IMAX, Dolby Cinema, Screen Unseen, etc.) and editable from the
-- Edit/Add modals as chips. The existing format filter (Screen Unseen /
-- Scream Unseen / regular) is being replaced by a Tag filter that reads
-- this column.
--
-- Backfill of existing rows lives in server/scripts/backfill-tags.js — the
-- regex peeling is awkward to do in pure SQL, easier to use the JS helper.

ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT '{}';

-- GIN index speeds up `$1 = ANY(tags)` and `tags @> ARRAY[...]` lookups,
-- which the tag filter on /api/watches uses.
CREATE INDEX IF NOT EXISTS idx_watches_tags ON watches USING GIN (tags);
