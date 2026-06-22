-- Notifications: a generic activity stream for the owner (friend events now;
-- comments/reactions/recommendations later). Single-user app, so no user scoping.
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  -- deep-link + context (e.g. friend_id, showtime). Read by the client to route.
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- collapses duplicates: a repeated event (same together match) won't re-notify.
  dedupe_key  TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications(created_at DESC) WHERE read_at IS NULL;

-- Web Push subscriptions for this instance's owner devices (the installed PWAs).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  endpoint   TEXT UNIQUE NOT NULL,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
