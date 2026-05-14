-- Task 6: Advanced analytics v2 (per-lead quality snapshots, daily source/pipeline
-- KPIs). Funnel statuses for `leads.status` are now documented as:
--   new → enriched → verified → pending → approved → contacted → replied → meeting
-- SQLite has no real enum; the application is the source of truth.

CREATE TABLE IF NOT EXISTS lead_quality_snapshots (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  snapshot_date TEXT NOT NULL,
  score REAL NOT NULL,
  completeness REAL NOT NULL DEFAULT 0,
  verification REAL NOT NULL DEFAULT 0,
  corroboration REAL NOT NULL DEFAULT 0,
  freshness REAL NOT NULL DEFAULT 0,
  persona_match REAL NOT NULL DEFAULT 0,
  track_record REAL NOT NULL DEFAULT 0,
  details_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lqs_lead ON lead_quality_snapshots(lead_id);
CREATE INDEX IF NOT EXISTS idx_lqs_date ON lead_quality_snapshots(snapshot_date);
CREATE UNIQUE INDEX IF NOT EXISTS uq_lqs_lead_day ON lead_quality_snapshots(lead_id, snapshot_date);

CREATE TABLE IF NOT EXISTS source_kpis_daily (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  pages_fetched INTEGER NOT NULL DEFAULT 0,
  pages_blocked INTEGER NOT NULL DEFAULT 0,
  leads_found INTEGER NOT NULL DEFAULT 0,
  leads_verified INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  avg_quality REAL NOT NULL DEFAULT 0,
  cost_per_verified_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_skd_day_src ON source_kpis_daily(day, source_domain);
CREATE INDEX IF NOT EXISTS idx_skd_day ON source_kpis_daily(day);

CREATE TABLE IF NOT EXISTS pipeline_kpis_daily (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL UNIQUE,
  leads_new INTEGER NOT NULL DEFAULT 0,
  leads_enriched INTEGER NOT NULL DEFAULT 0,
  leads_verified INTEGER NOT NULL DEFAULT 0,
  leads_pending INTEGER NOT NULL DEFAULT 0,
  leads_approved INTEGER NOT NULL DEFAULT 0,
  leads_contacted INTEGER NOT NULL DEFAULT 0,
  leads_replied INTEGER NOT NULL DEFAULT 0,
  leads_meeting INTEGER NOT NULL DEFAULT 0,
  jobs_completed INTEGER NOT NULL DEFAULT 0,
  jobs_failed INTEGER NOT NULL DEFAULT 0,
  enrichment_cost_usd REAL NOT NULL DEFAULT 0,
  scraper_cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pkd_day ON pipeline_kpis_daily(day);
