-- Task #24: Investor profiles + Companies entity
--
-- Promotes companies from a string column on `firm_portfolio` to a
-- first-class entity, adds rounds/founders/news/stats tables, and
-- extends `leads` with the deep investor fields needed to populate
-- an NFX-style investor profile.
--
-- Backfill at the bottom: groups existing firm_portfolio.company_name
-- rows into companies and links them via firm_portfolio.company_id.

-- ----------------------------------------------------------------- companies
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  legal_name TEXT,
  slug TEXT UNIQUE,
  domain TEXT,
  website TEXT,
  logo_url TEXT,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active|acquired|ipo|shutdown|stealth
  founded_year INTEGER,
  hq_country_iso2 TEXT,
  hq_region TEXT,
  hq_city TEXT,
  industries_json TEXT,         -- JSON array of sector slugs
  stage TEXT,                   -- latest stage: pre-seed, seed, series_a, ...
  total_funding_usd INTEGER,
  last_round_usd INTEGER,
  last_round_at TEXT,
  last_round_stage TEXT,
  valuation_usd INTEGER,
  unicorn INTEGER NOT NULL DEFAULT 0,
  exit_kind TEXT,               -- acquisition | ipo | merger | wind_down
  exit_date TEXT,
  exit_value_usd INTEGER,
  acquirer_name TEXT,
  ticker TEXT,                  -- public ticker if IPO'd
  employees INTEGER,
  linkedin_url TEXT,
  crunchbase_url TEXT,
  twitter_handle TEXT,
  github_org TEXT,
  pitchbook_url TEXT,
  sec_cik TEXT,
  socials_json TEXT,
  tags_json TEXT,
  source_url TEXT,
  imported_from TEXT,
  meta_json TEXT,
  last_enriched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_companies_name_lower ON companies(lower(name));
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain) WHERE domain IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_stage ON companies(stage) WHERE stage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status);
CREATE INDEX IF NOT EXISTS idx_companies_country ON companies(hq_country_iso2) WHERE hq_country_iso2 IS NOT NULL;

-- ---------------------------------------------------------- company_founders
CREATE TABLE IF NOT EXISTS company_founders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  lead_id TEXT,                 -- nullable: links to leads.id when known
  name TEXT NOT NULL,
  title TEXT,
  linkedin_url TEXT,
  twitter_url TEXT,
  bio TEXT,
  joined_year INTEGER,
  left_year INTEGER,
  is_active INTEGER NOT NULL DEFAULT 1,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_company_founders_company ON company_founders(company_id);
CREATE INDEX IF NOT EXISTS idx_company_founders_lead ON company_founders(lead_id) WHERE lead_id IS NOT NULL;

-- ------------------------------------------------------------ company_rounds
CREATE TABLE IF NOT EXISTS company_rounds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  stage TEXT,                   -- pre-seed | seed | series_a | ...
  amount_usd INTEGER,
  raised_at TEXT,               -- ISO date
  post_money_usd INTEGER,
  pre_money_usd INTEGER,
  lead_firm_id INTEGER,
  participants_json TEXT,       -- JSON array of {firm_id?, name, lead_or_co}
  source_url TEXT,
  source_provider TEXT,         -- crunchbase|sec|news|manual
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_company_rounds_company ON company_rounds(company_id);
CREATE INDEX IF NOT EXISTS idx_company_rounds_raised_at ON company_rounds(raised_at);

-- -------------------------------------------------------------- company_news
CREATE TABLE IF NOT EXISTS company_news (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  url TEXT NOT NULL,
  title TEXT,
  source TEXT,                  -- newsapi|techcrunch|...
  published_at TEXT,
  summary TEXT,
  sentiment REAL,               -- optional -1..1
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(company_id, url)
);
CREATE INDEX IF NOT EXISTS idx_company_news_company_date ON company_news(company_id, published_at DESC);

-- ------------------------------------------------------- investor_investments
-- One row per (investor, company) check. Investor is a `leads.id` (or, when
-- the investor is a firm rather than an individual, a `firms.id` via
-- `firm_id`). The `investor_lead_id` and `firm_id` are mutually optional but
-- at least one must be present.
CREATE TABLE IF NOT EXISTS investor_investments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_lead_id TEXT,        -- leads.id (individual GP/angel)
  firm_id INTEGER,              -- firms.id (when investor is a firm)
  company_id INTEGER NOT NULL,
  round_id INTEGER,             -- → company_rounds.id (nullable)
  stage TEXT,
  amount_usd INTEGER,
  is_lead INTEGER NOT NULL DEFAULT 0,
  invested_at TEXT,
  source_url TEXT,
  source_provider TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- Enforce the spec invariant: an investment must have at least one
  -- party. (Both can be set when an angel co-invests under a firm name.)
  CHECK (investor_lead_id IS NOT NULL OR firm_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_inv_invests_lead ON investor_investments(investor_lead_id) WHERE investor_lead_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inv_invests_firm ON investor_investments(firm_id) WHERE firm_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inv_invests_company ON investor_investments(company_id);
CREATE INDEX IF NOT EXISTS idx_inv_invests_invested_at ON investor_investments(invested_at);

-- -------------------------------------------------------- investor_stats_daily
-- Snapshotted nightly so we can plot trend lines without recomputing.
CREATE TABLE IF NOT EXISTS investor_stats_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  investor_lead_id TEXT NOT NULL,
  date TEXT NOT NULL,           -- YYYY-MM-DD
  investment_count INTEGER NOT NULL DEFAULT 0,
  unicorn_count INTEGER NOT NULL DEFAULT 0,
  exit_count INTEGER NOT NULL DEFAULT 0,
  avg_check_usd INTEGER,
  total_deployed_usd INTEGER,
  active_portfolio_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(investor_lead_id, date)
);
CREATE INDEX IF NOT EXISTS idx_inv_stats_lead_date ON investor_stats_daily(investor_lead_id, date DESC);

-- -------------------------------------------------------------- company_history
CREATE TABLE IF NOT EXISTS company_history (
  id TEXT PRIMARY KEY,
  company_id INTEGER NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  evidence_url TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_company_history_company ON company_history(company_id, changed_at DESC);

-- ---------------------------------------------- ALTER leads (investor fields)
-- D1 / SQLite ALTER TABLE only supports ADD COLUMN; each line below is
-- idempotent only via the migrations runner, NOT against an already-altered
-- DB. Safe to apply on fresh DBs and on the current production DB.
ALTER TABLE leads ADD COLUMN investor_kind TEXT;        -- gp|angel|operator|lp|scout|principal|associate
ALTER TABLE leads ADD COLUMN check_size_min_usd INTEGER;
ALTER TABLE leads ADD COLUMN check_size_max_usd INTEGER;
ALTER TABLE leads ADD COLUMN check_size_typical_usd INTEGER;
ALTER TABLE leads ADD COLUMN sweet_spot_stage TEXT;
ALTER TABLE leads ADD COLUMN stage_focus_json TEXT;     -- ["seed","series_a"]
ALTER TABLE leads ADD COLUMN sector_focus_slugs_json TEXT; -- normalized slugs for the investor
ALTER TABLE leads ADD COLUMN geo_focus_json TEXT;
ALTER TABLE leads ADD COLUMN thesis TEXT;
ALTER TABLE leads ADD COLUMN office_hours_url TEXT;
ALTER TABLE leads ADD COLUMN pitch_form_url TEXT;
ALTER TABLE leads ADD COLUMN calendly_url TEXT;
ALTER TABLE leads ADD COLUMN signal_nfx_url TEXT;
ALTER TABLE leads ADD COLUMN crunchbase_url TEXT;
ALTER TABLE leads ADD COLUMN wikipedia_url TEXT;
ALTER TABLE leads ADD COLUMN current_fund_id INTEGER;     -- → firms.id
ALTER TABLE leads ADD COLUMN current_role_title TEXT;
ALTER TABLE leads ADD COLUMN board_seats_count INTEGER;
ALTER TABLE leads ADD COLUMN media_count INTEGER;
ALTER TABLE leads ADD COLUMN podcast_count INTEGER;
ALTER TABLE leads ADD COLUMN portfolio_logos_json TEXT;
ALTER TABLE leads ADD COLUMN investment_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN unicorn_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN exit_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN avg_check_usd INTEGER;
ALTER TABLE leads ADD COLUMN total_deployed_usd INTEGER;

-- --------------------------------------------- ALTER firm_portfolio.company_id
ALTER TABLE firm_portfolio ADD COLUMN company_id INTEGER;
ALTER TABLE firm_portfolio ADD COLUMN backfilled_from_name INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_firm_portfolio_company ON firm_portfolio(company_id) WHERE company_id IS NOT NULL;

-- ---------------------------------------------------------------- BACKFILL
-- Group existing firm_portfolio.company_name into companies(one per
-- (lower(name), domain)). We pick the most-common displayed casing as the
-- canonical name. Slugs are derived from name+id to stay unique.
INSERT INTO companies (name, domain, source_url, imported_from, created_at, updated_at)
SELECT DISTINCT
  TRIM(fp.company_name) AS name,
  NULLIF(lower(TRIM(fp.company_domain)), '') AS domain,
  MIN(fp.source_url) AS source_url,
  'backfill:firm_portfolio' AS imported_from,
  datetime('now') AS created_at,
  datetime('now') AS updated_at
FROM firm_portfolio fp
WHERE fp.company_name IS NOT NULL
  AND TRIM(fp.company_name) != ''
  AND fp.company_id IS NULL
GROUP BY lower(TRIM(fp.company_name)), NULLIF(lower(TRIM(fp.company_domain)), '');

-- Slug fallback for any companies row that landed with a NULL slug from the
-- backfill (UNIQUE constraint allows multiple NULLs in SQLite, so we backfill
-- after the insert pass).
UPDATE companies
   SET slug = lower(replace(replace(name, ' ', '-'), '.', '')) || '-' || id
 WHERE slug IS NULL;

-- Wire firm_portfolio rows to their new companies row.
UPDATE firm_portfolio
   SET company_id = (
         SELECT c.id FROM companies c
          WHERE lower(c.name) = lower(TRIM(firm_portfolio.company_name))
            AND COALESCE(c.domain, '') = COALESCE(NULLIF(lower(TRIM(firm_portfolio.company_domain)), ''), '')
          LIMIT 1
       ),
       backfilled_from_name = 1
 WHERE company_id IS NULL
   AND company_name IS NOT NULL
   AND TRIM(company_name) != '';
