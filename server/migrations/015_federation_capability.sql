-- Capability-URL federation: a friend's whole credential is a secret URL.
-- inbound_token_hash now hashes the token embedded in the URL we hand out;
-- friend_url is the full capability URL a friend handed us (replaces
-- base_url + outbound_token). Pairing state (status/direction/invites) goes
-- away entirely — a friend row is healthy unless last_error says otherwise.

ALTER TABLE friends ADD COLUMN IF NOT EXISTS friend_url TEXT;

-- The old outbound bearer token hashes identically as a path token on an
-- upgraded peer, so existing pairs keep working once both sides deploy.
UPDATE friends SET friend_url = base_url || '/api/federation/' || outbound_token
 WHERE friend_url IS NULL AND outbound_token IS NOT NULL AND base_url IS NOT NULL;

ALTER TABLE friends
  DROP COLUMN IF EXISTS status,
  DROP COLUMN IF EXISTS direction,
  DROP COLUMN IF EXISTS base_url,
  DROP COLUMN IF EXISTS outbound_token;

DROP INDEX IF EXISTS idx_friends_status;
DROP TABLE IF EXISTS federation_invites;
