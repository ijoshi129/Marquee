-- Want-to-see list: films the user plans to catch, separate from watches.
-- Keyed by TMDB id (one entry per film); title is denormalized for display
-- when the tmdb_cache row is missing.
CREATE TABLE IF NOT EXISTS watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tmdb_id INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
