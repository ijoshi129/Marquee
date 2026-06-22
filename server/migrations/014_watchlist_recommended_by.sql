-- Remember which friend recommended a watchlist film, so the UI can credit them.
ALTER TABLE watchlist ADD COLUMN IF NOT EXISTS recommended_by TEXT;
