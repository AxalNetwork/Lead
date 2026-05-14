-- Task 13: first-class firm entity (VC/PE/family office/etc.)
-- People still live in `leads`; `firm_people` joins them to firms.
-- NOTE: firm_people.lead_id is TEXT to match leads.id (UUID) — the original
-- spec called for INTEGER, but joining to leads (which uses TEXT UUIDs) would
-- break with INTEGER. Documented deviation.

CREATE TABLE IF NOT EXISTS firms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  legal_name TEXT,
  slug TEXT UNIQUE,
  kind TEXT,
  website TEXT,
  domain TEXT,
  logo_url TEXT,
  hq_country_iso2 TEXT,
  hq_region TEXT,
  hq_city TEXT,
  geo_focus_json TEXT,
  stages_json TEXT,
  sectors_json TEXT,
  thesis TEXT,
  check_size_min_usd INTEGER,
  check_size_max_usd INTEGER,
  check_size_typical_usd INTEGER,
  aum_usd INTEGER,
  fund_count INTEGER,
  current_fund_name TEXT,
  current_fund_size_usd INTEGER,
  lead_or_co TEXT,
  portfolio_count INTEGER,
  unicorns_count INTEGER,
  exits_count INTEGER,
  notable_investments_json TEXT,
  founded_year INTEGER,
  team_size INTEGER,
  linkedin_url TEXT,
  crunchbase_url TEXT,
  twitter_handle TEXT,
  signal_nfx_url TEXT,
  openvc_url TEXT,
  pitchbook_url TEXT,
  socials_json TEXT,
  contact_email TEXT,
  submission_url TEXT,
  notes TEXT,
  source_url TEXT,
  imported_from TEXT,
  status TEXT DEFAULT 'new',
  quality_score REAL,
  last_enriched_at TEXT,
  last_modified TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_firms_kind ON firms(kind);
CREATE INDEX IF NOT EXISTS idx_firms_country ON firms(hq_country_iso2);
CREATE INDEX IF NOT EXISTS idx_firms_domain ON firms(domain);
CREATE INDEX IF NOT EXISTS idx_firms_check_size ON firms(check_size_typical_usd);
CREATE UNIQUE INDEX IF NOT EXISTS idx_firms_slug ON firms(slug);

CREATE TABLE IF NOT EXISTS firm_people (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL,
  lead_id TEXT NOT NULL,
  role TEXT,
  is_decision_maker INTEGER DEFAULT 0,
  started_at TEXT,
  ended_at TEXT,
  source_url TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(firm_id, lead_id)
);
CREATE INDEX IF NOT EXISTS idx_fp_firm ON firm_people(firm_id);
CREATE INDEX IF NOT EXISTS idx_fp_lead ON firm_people(lead_id);

CREATE TABLE IF NOT EXISTS firm_portfolio (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  firm_id INTEGER NOT NULL,
  company_name TEXT NOT NULL,
  company_domain TEXT,
  company_url TEXT,
  investment_year INTEGER,
  stage TEXT,
  amount_usd INTEGER,
  is_lead INTEGER DEFAULT 0,
  outcome TEXT,
  exit_value_usd INTEGER,
  source_url TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_fpo_firm ON firm_portfolio(firm_id);
CREATE INDEX IF NOT EXISTS idx_fpo_company ON firm_portfolio(company_name);

-- Audit log mirroring lead_history shape (Task 3).
CREATE TABLE IF NOT EXISTS firm_history (
  id TEXT PRIMARY KEY,
  firm_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  evidence_url TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_firm_history_firm_id ON firm_history(firm_id);
CREATE INDEX IF NOT EXISTS idx_firm_history_field ON firm_history(field);
CREATE INDEX IF NOT EXISTS idx_firm_history_changed_at ON firm_history(changed_at);
