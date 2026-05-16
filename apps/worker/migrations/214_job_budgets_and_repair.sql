-- Task #2: per-job budgets, repair-run audit, and per-host circuit breaker.
--
-- 1. jobs.budget_ms: maximum wall-clock the queue handler will allow a job
--    to spend in `running` before sweeping it to `timed_out`. Defaults are
--    applied at INSERT time when callers don't specify their own budget.
ALTER TABLE jobs ADD COLUMN budget_ms INTEGER;

-- Backfill historical rows so the sweeper has a sensible ceiling for any
-- pre-existing `running` job. Default budget per kind:
--   firmlist            5 minutes
--   firm_team_crawl     2 minutes
--   profile_fanout      1 minute
--   everything else     90 seconds (matches spec)
UPDATE jobs SET budget_ms = CASE
  WHEN kind = 'firmlist'        THEN 300000
  WHEN kind = 'firm_team_crawl' THEN 120000
  WHEN kind = 'profile_fanout'  THEN 60000
  ELSE 90000
END
WHERE budget_ms IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_running_started
  ON jobs(status, started_at) WHERE status = 'running';

-- 2. repair_runs: idempotent audit trail for /api/admin/repair-pipeline and
--    the nightly cron. One row per invocation; counts how many rows the
--    repair touched per phase so operators can confirm a no-op vs. a real
--    fix.
CREATE TABLE IF NOT EXISTS repair_runs (
  id            TEXT PRIMARY KEY,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  status        TEXT NOT NULL DEFAULT 'running'
                CHECK (status IN ('running','succeeded','failed')),
  triggered_by  TEXT NOT NULL,
  stuck_swept   INTEGER NOT NULL DEFAULT 0,
  roles_added   INTEGER NOT NULL DEFAULT 0,
  summaries_enq INTEGER NOT NULL DEFAULT 0,
  error         TEXT,
  detail_json   TEXT
);
CREATE INDEX IF NOT EXISTS idx_repair_runs_started ON repair_runs(started_at DESC);

-- 3. host_circuit_breaker: per-host fail counter. 5 fails in 10min trips the
--    breaker for 1h; subsequent fetches short-circuit with `circuit_open`.
CREATE TABLE IF NOT EXISTS host_circuit_breaker (
  host           TEXT PRIMARY KEY,
  fail_count     INTEGER NOT NULL DEFAULT 0,
  window_start   TEXT NOT NULL,
  tripped_until  TEXT
);
