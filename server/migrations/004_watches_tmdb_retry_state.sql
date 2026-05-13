-- Track auto-recheck attempts for watches that haven't resolved to a TMDB id.
-- The tmdb-rechecker worker runs every 6 hours and re-tries either
-- unseenLookup.resolveAndAssign (for Screen/Scream Unseens) or tmdb.autoMatch
-- (for everything else) on rows where tmdb_id IS NULL. Each miss bumps the
-- counter; after MAX_RETRIES the row drops out of the candidate pool so we
-- don't pound TMDB/Reddit forever on a permanently unresolvable title.

ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS tmdb_retry_count INTEGER NOT NULL DEFAULT 0;

ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS tmdb_last_retry_at TIMESTAMPTZ;

-- Partial index: only unresolved rows are candidates, so the index stays
-- small as the watch history grows.
CREATE INDEX IF NOT EXISTS watches_tmdb_retry_idx
  ON watches (tmdb_retry_count, tmdb_last_retry_at)
  WHERE tmdb_id IS NULL;
