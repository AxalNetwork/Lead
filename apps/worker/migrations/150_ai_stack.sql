-- Task #25: AI stack supporting tables + image-id columns.

-- Daily roll-up of Workers AI cost by purpose+model. Powers
-- /api/analytics/ae/ai-cost and /api/scrapers/health budget burn-down.
-- Updated by analytics/events.ts trackAi() on every non-cached AI call.
CREATE TABLE IF NOT EXISTS ai_cost_daily (
  day TEXT NOT NULL,
  purpose TEXT NOT NULL,
  model TEXT NOT NULL,
  neurons REAL NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, purpose, model)
);
CREATE INDEX IF NOT EXISTS idx_ai_cost_daily_day ON ai_cost_daily(day);

-- Pending docs to push into the AI Search namespace when the binding is
-- absent or temporarily failing. backfill-ai-search.ts drains this table.
CREATE TABLE IF NOT EXISTS ai_search_pending (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_search_pending_created ON ai_search_pending(created_at);

-- Cloudflare Images IDs for avatars/logos. These are nullable adds; existing
-- rows keep their *_url columns for backward compatibility with code paths
-- that haven't yet been migrated to imageUrl(id, variant).
ALTER TABLE leads ADD COLUMN avatar_id TEXT;
ALTER TABLE firms ADD COLUMN logo_id TEXT;
ALTER TABLE companies ADD COLUMN logo_id TEXT;
