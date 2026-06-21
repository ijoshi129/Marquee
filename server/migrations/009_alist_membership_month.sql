-- Per-month A-List membership overrides. Layers on top of alist_membership
-- (the per-year flags): a month present here wins over its year's flag, and a
-- month absent from both tables defaults to "had A-List". Lets a partial year —
-- A-List for only a few months — keep the savings for the months it covered
-- without crediting films watched in the uncovered months.
CREATE TABLE IF NOT EXISTS alist_membership_month (
  year INTEGER NOT NULL,
  month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  has_alist BOOLEAN NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (year, month)
);
