-- Film recommendations received from friends. The recipient can add one to
-- their watchlist or dismiss it.
CREATE TABLE IF NOT EXISTS recommendations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_instance_id UUID,
  from_name        TEXT NOT NULL,
  tmdb_id          INTEGER,
  title            TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'added', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- One live recommendation per (friend, film); re-recommending refreshes it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_recommendations_unique
  ON recommendations(from_instance_id, tmdb_id) WHERE tmdb_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recommendations_pending
  ON recommendations(created_at DESC) WHERE status = 'pending';
