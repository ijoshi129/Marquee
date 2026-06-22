-- Social events attached to a (local) watch: reactions and comments received
-- from friends (and, rarely, the owner's own on their own films). The owner's
-- instance is the hub for events on its watches and re-broadcasts them to its
-- friends, so a thread is visible to everyone who can see the film.
CREATE TABLE IF NOT EXISTS social_events (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id           UUID NOT NULL REFERENCES watches(id) ON DELETE CASCADE,
  author_instance_id UUID NOT NULL,
  author_name        TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('reaction', 'comment')),
  body               TEXT NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_events_watch ON social_events(watch_id, created_at);
-- One reaction per author per film (changing it replaces the old one).
CREATE UNIQUE INDEX IF NOT EXISTS idx_social_reaction_unique
  ON social_events(watch_id, author_instance_id) WHERE kind = 'reaction';
