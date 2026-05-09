-- Track parse retry attempts so chronically-failing emails get bumped out of
-- the pending queue instead of retrying every 5 minutes forever.
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS parse_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS last_attempted_at TIMESTAMPTZ;
