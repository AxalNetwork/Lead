CREATE TABLE IF NOT EXISTS analytics_daily (
  id TEXT PRIMARY KEY,
  metric_date TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL NOT NULL,
  dimension_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_date ON analytics_daily(metric_date);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_name ON analytics_daily(metric_name);

-- Renamed from dashboard_snapshots. Migration 357 introduces a completely
-- different table under that name (owner_email / page / filters_json — a
-- user-saved dashboard view), and because both used CREATE TABLE IF NOT
-- EXISTS the second one silently became a no-op and its index on
-- owner_email then failed. That aborted 357 and left migrations 358-380
-- permanently pending on every database that ran this file first.
--
-- This is the daily KPI roll-up the nightly aggregator writes; it has
-- nothing to do with saved dashboard views, so it gets its own name.
CREATE TABLE IF NOT EXISTS analytics_daily_snapshots (
  id TEXT PRIMARY KEY,
  snapshot_date TEXT NOT NULL,
  total_leads INTEGER DEFAULT 0,
  verified_leads INTEGER DEFAULT 0,
  approved_leads INTEGER DEFAULT 0,
  pending_leads INTEGER DEFAULT 0,
  active_jobs INTEGER DEFAULT 0,
  exports_count INTEGER DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_daily_snapshots_date ON analytics_daily_snapshots(snapshot_date);

CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT,
  props_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_analytics_events_name ON analytics_events(name);
CREATE INDEX IF NOT EXISTS idx_analytics_events_created_at ON analytics_events(created_at);
