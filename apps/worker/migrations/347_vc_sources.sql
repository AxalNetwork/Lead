-- Task #3: VC Source Registry.
--
-- Catalog of every credible public source the crawler can pull
-- VC / PE / angel intelligence from, organized by jurisdiction,
-- authority, data type, and access pattern. This is the single
-- source-of-truth lookup that every downstream adapter consults to
-- decide *where* to fetch a given data_type — no hard-coded URLs
-- scattered across extractors.
--
-- Idempotent seeding: UNIQUE (authority, source_name) lets the seed
-- migration (348_seed_vc_sources.sql) use INSERT OR REPLACE to refresh
-- the catalog without duplicating rows.

CREATE TABLE IF NOT EXISTS vc_sources (
  id                  TEXT PRIMARY KEY,
  jurisdiction        TEXT NOT NULL,                          -- us-federal | us-state-<st> | uk | sg | il | cn | in | ca | hk | eu-<cc> | global
  authority           TEXT NOT NULL,                          -- issuing org/agency (SEC, FCA, MAS, NVCA, …)
  data_type           TEXT NOT NULL,                          -- fund_registration | institutional_holdings | beneficial_ownership | …
  source_name         TEXT NOT NULL,                          -- "Form ADV", "CalPERS Private Equity Program", …
  base_url            TEXT NOT NULL,
  access_pattern      TEXT NOT NULL,                          -- html_scrape | json_api | xml_feed | pdf_download | bulk_index | rss_feed | search_query
  refresh_cadence     TEXT NOT NULL DEFAULT 'monthly',        -- realtime | hourly | daily | weekly | monthly | quarterly | annually
  authentication      TEXT NOT NULL DEFAULT 'none',           -- none | user_agent | api_key | oauth | login
  auth_notes          TEXT,                                   -- e.g. "SEC requires User-Agent: contact email"
  historical_depth    TEXT,                                   -- "since 1996" | "rolling 90d" | "current snapshot"
  data_fields_json    TEXT NOT NULL DEFAULT '[]',             -- JSON array of fields this source yields
  seed_url_template   TEXT,                                   -- url template w/ {placeholders} for the adapter
  enabled             INTEGER NOT NULL DEFAULT 1,             -- 0|1
  priority            INTEGER NOT NULL DEFAULT 50,            -- higher = preferred when multiple sources cover same data_type
  last_crawled_at     TEXT,
  last_success_at     TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (authority, source_name)
);

-- Primary lookup: "for this data_type in this jurisdiction, give me
-- the highest-priority enabled source" — used by services/sourceSelector.ts.
CREATE INDEX IF NOT EXISTS idx_vcs_lookup
  ON vc_sources(data_type, jurisdiction, priority DESC);

-- Health view: stalest enabled sources first.
CREATE INDEX IF NOT EXISTS idx_vcs_health
  ON vc_sources(enabled, last_success_at);

-- Filter by authority / jurisdiction for the operator UI.
CREATE INDEX IF NOT EXISTS idx_vcs_authority
  ON vc_sources(authority);
CREATE INDEX IF NOT EXISTS idx_vcs_jurisdiction
  ON vc_sources(jurisdiction, enabled);
