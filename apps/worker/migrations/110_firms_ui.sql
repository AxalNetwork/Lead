-- Task #20: Firm search, detail & analytics UI
-- 1. saved_filters: per-user saved query strings (entity-scoped).
CREATE TABLE IF NOT EXISTS saved_filters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  entity TEXT NOT NULL,           -- "firms", "leads", "firm_people", "portfolio"
  querystring TEXT NOT NULL,      -- raw search params, no leading "?"
  created_by TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(created_by, entity, name)
);
CREATE INDEX IF NOT EXISTS idx_saved_filters_owner ON saved_filters(created_by, entity);

-- 2. firm_analytics_daily: nightly-materialized aggregates so the analytics
-- dashboard loads under 500ms. One row per (snapshot_date, kind) where kind
-- enumerates the chart payload type.
CREATE TABLE IF NOT EXISTS firm_analytics_daily (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  snapshot_date TEXT NOT NULL,    -- YYYY-MM-DD
  kind TEXT NOT NULL,             -- heatmap | geo | sector_roi | connected | distribution_check | distribution_aum | success_rate | timeline | coverage_gaps | funnel
  payload_json TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(snapshot_date, kind)
);
CREATE INDEX IF NOT EXISTS idx_fad_kind_date ON firm_analytics_daily(kind, snapshot_date DESC);
