-- Task #2: Crawler Operator Console.
--
-- Adds the `ops_audit` table that every mutating control endpoint
-- under /api/ops/* writes to. Also extends crawler_host_config with
-- the three operator-visible diagnostic columns the host-health row
-- expects (`quarantined_at`, `last_error`, `last_tested_at`).
--
-- Schema note: migration 341 already declared `quarantined_until`
-- (the timestamp the quarantine *expires*). We add `quarantined_at`
-- alongside it to record *when* the host was put under quarantine —
-- the two are independent: a host can have `quarantined_at` set
-- while `quarantined_until` is null (indefinite quarantine).

CREATE TABLE IF NOT EXISTS ops_audit (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_email   TEXT NOT NULL,
  action        TEXT NOT NULL,                    -- e.g. host.quarantine, pause.all, test-url
  target_kind   TEXT,                             -- host | profile_type | entity | url | global
  target_id     TEXT,                             -- the specific target value, if any
  payload_json  TEXT,                             -- JSON-serialized request body / result summary
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ops_audit_created     ON ops_audit(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_audit_actor_time  ON ops_audit(actor_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_audit_target_time ON ops_audit(target_kind, target_id, created_at DESC);

-- crawler_host_config diagnostic columns (additive, nullable so the
-- migration is safe to re-run via the "IF NOT EXISTS" pattern that
-- SQLite doesn't natively support for ALTER TABLE ADD COLUMN — the
-- migration runner is expected to handle "duplicate column name"
-- errors as a no-op on idempotent re-run).
ALTER TABLE crawler_host_config ADD COLUMN quarantined_at  TEXT;
ALTER TABLE crawler_host_config ADD COLUMN last_error      TEXT;
ALTER TABLE crawler_host_config ADD COLUMN last_tested_at  TEXT;

CREATE INDEX IF NOT EXISTS idx_crawler_host_config_quarantine
  ON crawler_host_config(quarantined_at);

-- Task #2: time-leading indexes for the /api/ops/crawler/* aggregations,
-- which run every ~10s under the operator console's polling loop and
-- scan broad N-hour / N-day windows on the telemetry tables. Without
-- these, the planner falls back to host-leading or status-leading
-- composites that still require a full timestamp filter pass.
CREATE INDEX IF NOT EXISTS idx_crawler_fetch_log_time
  ON crawler_fetch_log(fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_pwr_run_at
  ON profile_workflow_runs(run_at DESC);
