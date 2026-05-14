-- Task 5: discovery candidates + provider usage + per-lead enrichment ledger.

CREATE TABLE IF NOT EXISTS discovery_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT,
  firm_domain TEXT,
  query TEXT,
  source TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  snippet TEXT,
  name TEXT,
  org TEXT,
  persona_role TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  resolved_lead_id TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_discovery_status ON discovery_candidates(status);
CREATE INDEX IF NOT EXISTS idx_discovery_firm ON discovery_candidates(firm_domain);
CREATE INDEX IF NOT EXISTS idx_discovery_created ON discovery_candidates(created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_discovery_url ON discovery_candidates(firm_domain, url);

CREATE TABLE IF NOT EXISTS provider_usage (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  day TEXT NOT NULL,
  calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  blocked_calls INTEGER NOT NULL DEFAULT 0,
  last_block_reason TEXT,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_provider_day ON provider_usage(provider, day);
CREATE INDEX IF NOT EXISTS idx_provider_usage_day ON provider_usage(day);

ALTER TABLE leads ADD COLUMN last_enriched_at TEXT;
ALTER TABLE leads ADD COLUMN locked_fields_json TEXT;
ALTER TABLE leads ADD COLUMN enrichment_log_json TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_last_enriched ON leads(last_enriched_at);
