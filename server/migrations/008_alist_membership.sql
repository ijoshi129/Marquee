-- Per-year A-List membership flags. Only years that deviate from the default
-- are stored: a missing year is treated as "had A-List" so existing data keeps
-- its savings without a backfill. A row with has_alist = FALSE marks a year the
-- user wasn't a member, so that year's films are excluded from the A-List value
-- calculation (it would otherwise post a meaningless loss against the fee).
CREATE TABLE IF NOT EXISTS alist_membership (
  year INTEGER PRIMARY KEY,
  has_alist BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
