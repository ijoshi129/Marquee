-- Track background Trakt history sync state per watch.
ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS trakt_sync_requested_at TIMESTAMPTZ;

ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS trakt_synced_at TIMESTAMPTZ;

ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS trakt_sync_error TEXT;

ALTER TABLE watches
  ADD COLUMN IF NOT EXISTS trakt_sync_attempts INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS watches_trakt_sync_pending_idx
  ON watches (trakt_sync_requested_at, trakt_sync_attempts)
  WHERE trakt_sync_requested_at IS NOT NULL
    AND trakt_synced_at IS NULL;
