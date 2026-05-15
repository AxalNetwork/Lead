-- Task #44: Prospect database (accounts, buyers, signals).
--
-- Adds a customer-discovery layer that lives alongside the existing
-- VC/firm/portfolio entities. Six tables:
--   accounts          companies we might sell to
--   buyers            individuals at those accounts (decision makers)
--   signals           dated buying-intent + fit events for an account
--   account_tech      detected vendors / tools per account
--   account_history   field-level change log for accounts
--   role_taxonomy     normalized buyer titles + aliases (seeded)

-- --------------------------------------------------------------------- accounts
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,                     -- uuid v4
  name TEXT NOT NULL,
  legal_name TEXT,
  domain TEXT,                             -- canonical apex (acme.com)
  website TEXT,
  logo_id TEXT,                            -- Cloudflare Images id
  description TEXT,
  industry TEXT,                           -- free-form primary industry
  industries_json TEXT,                    -- JSON array of sector slugs
  size_band TEXT,                          -- 1-10|11-50|51-200|201-500|501-1000|1001-5000|5001+
  employees INTEGER,
  founded_year INTEGER,
  hq_country_iso2 TEXT,
  hq_region TEXT,
  hq_city TEXT,
  timezone TEXT,
  funding_stage TEXT,
  total_funding_usd INTEGER,
  last_round_usd INTEGER,
  last_round_at TEXT,
  revenue_band TEXT,                       -- <1m|1-10m|10-50m|50-250m|250m-1b|1b+
  linkedin_url TEXT,
  crunchbase_url TEXT,
  twitter_handle TEXT,
  github_org TEXT,
  status TEXT NOT NULL DEFAULT 'active',   -- active|won|lost|paused|disqualified
  owner_email TEXT,                        -- internal owner
  fit_score REAL NOT NULL DEFAULT 0,       -- 0..100  ICP fit (set by persona task)
  intent_score REAL NOT NULL DEFAULT 0,    -- 0..100  signal-derived intent
  account_score REAL NOT NULL DEFAULT 0,   -- 0..100  blended (0.6*intent + 0.4*fit)
  fit_breakdown_json TEXT,                 -- per-component contributions
  intent_breakdown_json TEXT,              -- per-signal-kind contributions
  score_recomputed_at TEXT,
  embedding_dim INTEGER,                   -- recorded after vectorize upsert
  embedded_at TEXT,
  source_url TEXT,
  imported_from TEXT,
  meta_json TEXT,
  last_enriched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_accounts_name_lower ON accounts(lower(name));
CREATE INDEX IF NOT EXISTS idx_accounts_domain ON accounts(domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_status ON accounts(status);
CREATE INDEX IF NOT EXISTS idx_accounts_country ON accounts(hq_country_iso2) WHERE hq_country_iso2 IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_industry ON accounts(industry) WHERE industry IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_size_band ON accounts(size_band) WHERE size_band IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_accounts_account_score ON accounts(account_score DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_intent_score ON accounts(intent_score DESC);
CREATE INDEX IF NOT EXISTS idx_accounts_owner ON accounts(owner_email) WHERE owner_email IS NOT NULL;

-- --------------------------------------------------------------------- buyers
CREATE TABLE IF NOT EXISTS buyers (
  id TEXT PRIMARY KEY,                     -- uuid v4
  account_id TEXT NOT NULL,
  name TEXT,
  email TEXT,
  title TEXT,
  role_slug TEXT,                          -- → role_taxonomy.slug
  seniority TEXT,                          -- ic|manager|director|vp|c_suite|owner
  department TEXT,                         -- engineering|product|sales|...
  linkedin_url TEXT,
  twitter_url TEXT,
  phone TEXT,
  is_decision_maker INTEGER NOT NULL DEFAULT 0,
  is_champion INTEGER NOT NULL DEFAULT 0,
  influence_score REAL NOT NULL DEFAULT 0, -- 0..100
  last_seen_at TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_buyers_account ON buyers(account_id);
CREATE INDEX IF NOT EXISTS idx_buyers_role_slug ON buyers(role_slug) WHERE role_slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_buyers_seniority ON buyers(seniority) WHERE seniority IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_buyers_email ON buyers(lower(email)) WHERE email IS NOT NULL;

-- --------------------------------------------------------------------- signals
-- One row per detected buying-intent / fit event. The `kind` column is
-- validated against the application-level SIGNAL_KINDS allowlist before
-- insert. Each signal carries a positive `weight` (1..10) which feeds the
-- intent-score decay function.
CREATE TABLE IF NOT EXISTS signals (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  buyer_id TEXT,                           -- nullable: account-level signals
  kind TEXT NOT NULL,                      -- enforced in app layer
  source TEXT,                             -- crawler/source name (greenhouse|g2|...)
  weight REAL NOT NULL DEFAULT 1.0,        -- 1..10 typical
  confidence REAL NOT NULL DEFAULT 1.0,    -- 0..1
  payload_json TEXT,                       -- arbitrary structured evidence
  evidence_url TEXT,
  occurred_at TEXT NOT NULL,               -- ISO8601 — used for decay
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                         -- optional manual expiry
  created_by TEXT,                         -- email of operator (manual adds)
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_signals_account ON signals(account_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_buyer ON signals(buyer_id) WHERE buyer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_signals_kind ON signals(kind);
CREATE INDEX IF NOT EXISTS idx_signals_occurred ON signals(occurred_at DESC);

-- ---------------------------------------------------------------- account_tech
-- Detected stack: BuiltWith-style entries. Multiple per (account, vendor)
-- are allowed when first/last detection windows differ.
CREATE TABLE IF NOT EXISTS account_tech (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  vendor TEXT NOT NULL,                    -- normalized vendor slug
  category TEXT,                           -- crm|analytics|cdn|payments|...
  confidence REAL NOT NULL DEFAULT 1.0,
  first_detected_at TEXT,
  last_detected_at TEXT,
  source TEXT,                             -- builtwith|wappalyzer|manual
  evidence_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(account_id, vendor, source)
);
CREATE INDEX IF NOT EXISTS idx_account_tech_account ON account_tech(account_id);
CREATE INDEX IF NOT EXISTS idx_account_tech_vendor ON account_tech(vendor);

-- ------------------------------------------------------------- account_history
CREATE TABLE IF NOT EXISTS account_history (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  evidence_url TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_account_history_account ON account_history(account_id, changed_at DESC);

-- --------------------------------------------------------------- role_taxonomy
-- Seeded from apps/worker/data/roles.json by the seeder helper. Aliases
-- live in `aliases_json` (lowercased substrings) so a fuzzy classifier
-- can resolve a free-form title to a canonical slug.
CREATE TABLE IF NOT EXISTS role_taxonomy (
  slug TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  department TEXT,                         -- engineering|product|sales|...
  seniority TEXT,                          -- ic|manager|director|vp|c_suite|owner
  decision_maker INTEGER NOT NULL DEFAULT 0,
  aliases_json TEXT,                       -- JSON array of lowercased aliases
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_role_taxonomy_dept ON role_taxonomy(department) WHERE department IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_role_taxonomy_seniority ON role_taxonomy(seniority) WHERE seniority IS NOT NULL;
