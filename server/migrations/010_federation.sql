-- Federation: lets independent Marquee instances connect as "friends" and share
-- a chosen subset of their data over token-gated HTTP. Each instance owns one
-- identity, holds a row per friend (with per-direction tokens), caches what it
-- pulls from friends, and exposes only what the owner opts into sharing.

-- This instance's own identity. Single row, guarded by a fixed-true PK so a
-- second INSERT can only conflict, never duplicate.
CREATE TABLE IF NOT EXISTS federation_identity (
  id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  instance_id  UUID NOT NULL DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL DEFAULT 'Marquee',
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per remote instance we've paired with. Token model is asymmetric:
--   inbound_token_hash — sha256 of the token THEY present when calling us; we
--                        only ever compare, so we store the hash, not the secret.
--   outbound_token     — plaintext token WE present when polling them; we must
--                        replay it on every call, so it's kept in the clear.
-- status drives the lifecycle; 'revoked' instantly stops a token from matching.
CREATE TABLE IF NOT EXISTS friends (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  remote_instance_id UUID UNIQUE,
  display_name       TEXT,
  avatar_url         TEXT,
  base_url           TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'revoked', 'error')),
  direction          TEXT CHECK (direction IN ('invited', 'accepted')),
  inbound_token_hash TEXT,
  outbound_token     TEXT,
  last_synced_at     TIMESTAMPTZ,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_friends_status ON friends(status);
CREATE INDEX IF NOT EXISTS idx_friends_inbound_token
  ON friends(inbound_token_hash) WHERE inbound_token_hash IS NOT NULL;

-- One-time pairing secrets minted by the inviter, redeemed once by the invitee.
-- Self-expiring + single-use; only the hash of the code is stored.
CREATE TABLE IF NOT EXISTS federation_invites (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_hash     TEXT NOT NULL,
  expires_at    TIMESTAMPTZ NOT NULL,
  redeemed_at   TIMESTAMPTZ,
  friend_id     UUID REFERENCES friends(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_invites_unredeemed
  ON federation_invites(expires_at) WHERE redeemed_at IS NULL;

-- What the owner opts into exposing through the federation API. Single row.
CREATE TABLE IF NOT EXISTS federation_settings (
  id                BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  share_ratings     BOOLEAN NOT NULL DEFAULT TRUE,
  share_activity    BOOLEAN NOT NULL DEFAULT TRUE,
  share_now_playing BOOLEAN NOT NULL DEFAULT TRUE,
  share_stats       BOOLEAN NOT NULL DEFAULT TRUE,
  activity_limit    INTEGER NOT NULL DEFAULT 50,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-film opt-out. A private watch never leaves this instance, regardless of
-- the sharing settings above. Defaults FALSE so nothing is retroactively hidden.
ALTER TABLE watches ADD COLUMN IF NOT EXISTS is_private BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_watches_not_private ON watches(id) WHERE is_private = FALSE;

-- Local mirror of a friend's shared watches. payload is stored in the exact
-- shape the client's WatchCard consumes, so the UI needs no translation.
CREATE TABLE IF NOT EXISTS friend_watches (
  friend_id       UUID NOT NULL REFERENCES friends(id) ON DELETE CASCADE,
  remote_watch_id TEXT NOT NULL,
  payload         JSONB NOT NULL,
  watched_at      TIMESTAMPTZ,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (friend_id, remote_watch_id)
);
CREATE INDEX IF NOT EXISTS idx_friend_watches_recency
  ON friend_watches(friend_id, watched_at DESC);

-- Local mirror of a friend's profile (stats + now-playing), one row per friend.
CREATE TABLE IF NOT EXISTS friend_profiles (
  friend_id   UUID PRIMARY KEY REFERENCES friends(id) ON DELETE CASCADE,
  stats       JSONB,
  now_playing JSONB,
  fetched_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
