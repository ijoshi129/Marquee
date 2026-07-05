-- ntfy push channel, configured from the UI (Notifications bell) rather than
-- env so it can be changed without a redeploy. Single row; disabled until the
-- owner fills in a server + topic.
CREATE TABLE IF NOT EXISTS ntfy_settings (
  id               BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  enabled          BOOLEAN NOT NULL DEFAULT FALSE,
  server_url       TEXT NOT NULL DEFAULT 'https://ntfy.sh',
  topic            TEXT,
  token            TEXT,
  notify_comment   BOOLEAN NOT NULL DEFAULT TRUE,
  notify_recommend BOOLEAN NOT NULL DEFAULT TRUE,
  notify_together  BOOLEAN NOT NULL DEFAULT TRUE,
  notify_booked    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
