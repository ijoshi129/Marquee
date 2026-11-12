-- Small key/value store for state that has to survive a restart but doesn't
-- merit a table of its own. First use: the last Screen/Scream Unseen megathread
-- the resolver found, so it still has somewhere to look when Reddit refuses
-- the feeds it normally finds the current one through.
CREATE TABLE IF NOT EXISTS app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
