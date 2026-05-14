-- Per-fetch-attempt audit log. One row per tier attempt (direct, browser,
-- proxy, scraping API, wayback). Used by GET /api/scrapers/health to compute
-- per-host 24h roll-ups (block rate, duration percentiles, cost, tier mix).

CREATE TABLE IF NOT EXISTS fetch_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT,
  host TEXT NOT NULL,
  url TEXT NOT NULL,
  tier INTEGER NOT NULL,           -- 0=direct, 1=browser, 2=proxy, 3=scraping_api, 4=wayback
  status INTEGER NOT NULL,         -- HTTP status, 0 on transport failure
  bytes INTEGER NOT NULL DEFAULT 0,
  block_reason TEXT,               -- null on success
  duration_ms INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_fetch_log_host_created ON fetch_log(host, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fetch_log_created ON fetch_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fetch_log_job ON fetch_log(job_id);
