-- Task 7: Compliance — DNC list, PII access log, source policies (robots cache).

CREATE TABLE IF NOT EXISTS dnc_list (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,            -- 'email' | 'phone' | 'domain' | 'linkedin'
  value TEXT NOT NULL,           -- normalized (lowercased email, E.164 phone, etc.)
  reason TEXT,
  added_by TEXT,
  added_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dnc_kind_value ON dnc_list(kind, value);
CREATE INDEX IF NOT EXISTS idx_dnc_kind ON dnc_list(kind);

ALTER TABLE leads ADD COLUMN do_not_contact INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_leads_dnc ON leads(do_not_contact);

CREATE TABLE IF NOT EXISTS pii_access_log (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  lead_id TEXT NOT NULL,
  fields_json TEXT NOT NULL,       -- ["email","phone","linkedin_url",...]
  reason TEXT,                     -- e.g. "ui:detail" | "api:export" | header X-PII-Reason
  ip TEXT,
  user_agent TEXT,
  accessed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pii_user_time ON pii_access_log(user_email, accessed_at);
CREATE INDEX IF NOT EXISTS idx_pii_lead ON pii_access_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_pii_time ON pii_access_log(accessed_at);

-- Robots/policy cache per source (24h TTL enforced in app).
CREATE TABLE IF NOT EXISTS source_policies (
  domain TEXT PRIMARY KEY,
  robots_txt TEXT,
  robots_disallow_json TEXT,       -- normalized list of disallowed prefixes
  crawl_delay_sec REAL,
  tos_blocked INTEGER NOT NULL DEFAULT 0,
  tos_reason TEXT,
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_source_policies_expires ON source_policies(expires_at);
