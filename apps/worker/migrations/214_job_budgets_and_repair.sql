-- Task #2: per-job budgets, repair-run audit, and per-host circuit breaker.
--
-- 1. jobs.budget_ms: maximum wall-clock the queue handler will allow a job
--    to spend in `running` before sweeping it to `timed_out`. Defaults are
--    applied at INSERT time when callers don't specify their own budget.
ALTER TABLE jobs ADD COLUMN budget_ms INTEGER;

-- `running_started_at` is the canonical anchor for the budget clock. The
-- legacy `started_at` column is `NOT NULL` and historically stamped at
-- enqueue time, so we cannot use it: under backlog its age reflects
-- queued time, not running time. New `running_started_at` is nullable
-- and stamped only on the queued -> running transition by
-- `markRunning`. Backfill for in-flight rows uses `started_at` so the
-- sweeper has a sensible anchor for pre-existing running jobs.
ALTER TABLE jobs ADD COLUMN running_started_at TEXT;
UPDATE jobs SET running_started_at = started_at
 WHERE running_started_at IS NULL
   AND status IN ('running','succeeded','failed','timed_out','cancelled','dead_letter');

-- Backfill historical rows so the sweeper has a sensible ceiling for any
-- pre-existing `running` job. Default budget per kind:
--   firmlist            5 minutes
--   firm_team_crawl     2 minutes
--   profile_fanout      1 minute
--   everything else     90 seconds (matches spec)
-- Fanout jobs are emitted with `kind = 'url'` and a `name` prefix of
-- `profile_fanout:<child_url>` (see scraper/pipeline.ts). Match both
-- the canonical kind and the name prefix so the 60s budget actually
-- applies in production.
UPDATE jobs SET budget_ms = CASE
  WHEN kind = 'firmlist'                        THEN 300000
  WHEN kind = 'firm_team_crawl'                 THEN 120000
  WHEN kind = 'profile_fanout'                  THEN 60000
  WHEN name LIKE 'profile_fanout:%'             THEN 60000
  ELSE 90000
END
WHERE budget_ms IS NULL;

CREATE INDEX IF NOT EXISTS idx_jobs_running_started
  ON jobs(status, running_started_at) WHERE status = 'running';

-- AFTER INSERT trigger: when a caller doesn't set `budget_ms`, default it
-- by `kind`. This catches every INSERT INTO jobs callsite (replay,
-- fanout, discover, uploads, imports, sources registry, etc.) so the
-- sweeper's `budget_ms IS NOT NULL` filter never excludes a job.
CREATE TRIGGER IF NOT EXISTS trg_jobs_budget_default
AFTER INSERT ON jobs
FOR EACH ROW
WHEN NEW.budget_ms IS NULL
BEGIN
  UPDATE jobs SET budget_ms = CASE
    WHEN NEW.kind = 'firmlist'                        THEN 300000
    WHEN NEW.kind = 'firm_team_crawl'                 THEN 120000
    WHEN NEW.kind = 'profile_fanout'                  THEN 60000
    WHEN NEW.name LIKE 'profile_fanout:%'             THEN 60000
    ELSE 90000
  END WHERE id = NEW.id;
END;

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
