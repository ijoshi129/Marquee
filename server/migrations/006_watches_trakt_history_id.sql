-- Trakt history entry id for each synced watch. Lets a resync remove the
-- stale play before re-adding it, instead of leaving a duplicate on Trakt.
ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS trakt_history_id BIGINT;
