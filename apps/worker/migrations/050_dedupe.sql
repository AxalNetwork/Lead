-- Task 2: entity resolution.
-- Canonical keys stored alongside the row so match.ts can do indexed lookups.

ALTER TABLE leads ADD COLUMN merged_into TEXT;
ALTER TABLE leads ADD COLUMN canonical_email_key TEXT;
ALTER TABLE leads ADD COLUMN canonical_phone_key TEXT;
ALTER TABLE leads ADD COLUMN canonical_linkedin_key TEXT;
ALTER TABLE leads ADD COLUMN canonical_name_firm_key TEXT;
ALTER TABLE leads ADD COLUMN canonical_name_city_key TEXT;
ALTER TABLE leads ADD COLUMN provider TEXT;
ALTER TABLE leads ADD COLUMN provider_score REAL;

CREATE INDEX IF NOT EXISTS idx_leads_merged_into ON leads(merged_into);
CREATE INDEX IF NOT EXISTS idx_leads_canon_email ON leads(canonical_email_key);
CREATE INDEX IF NOT EXISTS idx_leads_canon_phone ON leads(canonical_phone_key);
CREATE INDEX IF NOT EXISTS idx_leads_canon_linkedin ON leads(canonical_linkedin_key);
CREATE INDEX IF NOT EXISTS idx_leads_canon_name_firm ON leads(canonical_name_firm_key);
CREATE INDEX IF NOT EXISTS idx_leads_canon_name_city ON leads(canonical_name_city_key);

CREATE TABLE IF NOT EXISTS dedupe_review (
  id TEXT PRIMARY KEY,
  primary_lead_id TEXT NOT NULL,
  candidate_lead_id TEXT NOT NULL,
  score REAL NOT NULL,
  reasons_json TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at TEXT,
  skip_until TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dedupe_review_status ON dedupe_review(status);
CREATE INDEX IF NOT EXISTS idx_dedupe_review_created_at ON dedupe_review(created_at);
CREATE INDEX IF NOT EXISTS idx_dedupe_review_primary ON dedupe_review(primary_lead_id);
CREATE INDEX IF NOT EXISTS idx_dedupe_review_candidate ON dedupe_review(candidate_lead_id);
