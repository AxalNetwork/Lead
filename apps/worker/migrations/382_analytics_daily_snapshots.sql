-- Companion to the dashboard_snapshots collision fix.
--
-- 005_analytics.sql now creates this table directly, but databases that
-- applied the older version of 005 got `dashboard_snapshots` instead — and
-- 357 drops that name to reclaim it for saved dashboard views. This gives
-- the nightly KPI roll-up its own table on those databases.
--
-- The roll-up is derived: services/analytics_v2.aggregator.ts rebuilds a row
-- every night from leads / jobs / exports, so starting empty costs history,
-- not correctness.
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

CREATE INDEX IF NOT EXISTS idx_analytics_daily_snapshots_date
  ON analytics_daily_snapshots(snapshot_date DESC);
