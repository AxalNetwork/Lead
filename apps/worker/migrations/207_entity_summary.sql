-- Task #4: materialized rollup for sub-50ms list queries. One row per
-- entity, rebuilt asynchronously from current facts on every write.

CREATE TABLE IF NOT EXISTS entity_summary (
  entity_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                           -- person | org
  display_name TEXT,
  primary_role TEXT,                            -- e.g. 'investor' | 'firm' | 'account' | 'founder'
  primary_employer TEXT,                        -- display name of employer entity
  primary_employer_entity_id TEXT,
  country_iso2 TEXT,
  region TEXT,
  city TEXT,
  sectors_csv TEXT,                             -- comma-separated sector slugs
  stages_csv TEXT,
  geos_csv TEXT,
  check_size_min_usd INTEGER,
  check_size_max_usd INTEGER,
  primary_email TEXT,
  primary_linkedin TEXT,
  primary_domain TEXT,
  quality_score REAL NOT NULL DEFAULT 0,
  fit_max_score REAL NOT NULL DEFAULT 0,        -- max fit_score across projects
  intent_score REAL NOT NULL DEFAULT 0,
  unicorn_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  rebuilt_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_summary_kind_country
  ON entity_summary(kind, country_iso2, fit_max_score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_summary_fit
  ON entity_summary(fit_max_score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_summary_intent
  ON entity_summary(intent_score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_summary_role
  ON entity_summary(primary_role);
CREATE INDEX IF NOT EXISTS idx_entity_summary_check
  ON entity_summary(check_size_max_usd) WHERE check_size_max_usd IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_entity_summary_unicorns
  ON entity_summary(unicorn_count DESC) WHERE unicorn_count > 0;
