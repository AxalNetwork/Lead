-- Task #6: In-house crawler engine. State tables for the per-host
-- politeness controller and an audit log of every fetch attempt
-- (mirrors `fetch_log` for the legacy scraper but lives independently
-- so the new crawler can be operated/observed without touching the
-- legacy pipeline). The frontier table is the enqueue target for
-- /api/crawler/enqueue; consumption is owned by a later task.

CREATE TABLE IF NOT EXISTS crawler_host_config (
  host                TEXT PRIMARY KEY,
  recommended_tier    INTEGER NOT NULL DEFAULT 0,
  max_rps             REAL    NOT NULL DEFAULT 0.5,   -- 1 req / 2s default
  robots_cached_at    TEXT,
  robots_body         TEXT,
  quarantined_until   TEXT,
  last_success_at     TEXT,
  success_count       INTEGER NOT NULL DEFAULT 0,
  failure_count       INTEGER NOT NULL DEFAULT 0,
  notes               TEXT,
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS crawler_fetch_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  url          TEXT NOT NULL,
  host         TEXT NOT NULL,
  tier_used    INTEGER NOT NULL,
  status       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  fetched_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crawler_fetch_log_host_time
  ON crawler_fetch_log(host, fetched_at DESC);

CREATE TABLE IF NOT EXISTS crawler_frontier (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  url             TEXT NOT NULL UNIQUE,
  host            TEXT NOT NULL,
  profile_type_hint TEXT,
  priority        INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'queued',
  enqueued_by_email TEXT,
  enqueued_at     TEXT NOT NULL DEFAULT (datetime('now')),
  processed_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_crawler_frontier_status_priority
  ON crawler_frontier(status, priority DESC, enqueued_at ASC);
