-- Task #6: stop avoidable crawler error spam.
--
-- Adds a `skipped` terminal job status + `skip_reason` column so the
-- queue preflight (see apps/worker/src/scraper/preflight.ts) can
-- short-circuit jobs that would obviously fail (missing PROXY_URL,
-- open circuit breaker, ToS-blocked host, gated source needing
-- manual paste) into a single skip row INSTEAD of letting them
-- execute, fail inside the fetcher, and produce one error_log
-- cluster row per attempt.
--
-- Migration slot deviation: spec slotted at "next available" but
-- 350-371 are all taken (per the Task #13/#14/#18/#2/#3/#4
-- contract-update precedent in replit.md). Future migrations should
-- number from 373.
--
-- Schema changes:
--   1. jobs.skip_reason (text, nullable). Stable enum of skip codes:
--        proxy_not_configured | circuit_open | tos_blocked |
--        gated_source_use_manual_paste
--      (free-form colon suffix allowed, e.g. tos_blocked:tiktok.com).
--   2. discovered_urls.tos_blocked_at (text, nullable, ISO-8601). When
--      the preflight tos-gates a URL we stamp this column so the
--      frontier never re-enqueues it.
--   3. Job state-machine triggers (192/193) extended to allow both
--      running -> skipped (the hot path: preflight runs after
--      markRunning) and queued -> skipped (defense-in-depth for any
--      future pre-dispatch gate that skips before markRunning).
--      The existing trg_jobs_status_check_ins still forces inserts
--      to queued/running, so neither transition can be smuggled in
--      via INSERT.

ALTER TABLE jobs            ADD COLUMN skip_reason   TEXT;
ALTER TABLE discovered_urls ADD COLUMN tos_blocked_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_skipped
  ON jobs(status, finished_at DESC) WHERE status = 'skipped';
CREATE INDEX IF NOT EXISTS idx_jobs_skip_reason
  ON jobs(skip_reason, finished_at DESC) WHERE skip_reason IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_du_tos_blocked
  ON discovered_urls(tos_blocked_at) WHERE tos_blocked_at IS NOT NULL;

-- Rebuild the migration-193 triggers to admit `skipped` as a terminal
-- state reachable from `running`. The check-insert trigger keeps the
-- queued/running-only invariant. The dead-letter-rule triggers are
-- preserved verbatim (skipped doesn't interact with retry_count).
DROP TRIGGER IF EXISTS trg_jobs_status_transition;

CREATE TRIGGER trg_jobs_status_transition
BEFORE UPDATE OF status ON jobs
FOR EACH ROW
WHEN OLD.status != NEW.status
  AND NOT (
    (OLD.status = 'queued'      AND NEW.status IN ('running','cancelled','dead_letter','skipped'))
 OR (OLD.status = 'running'     AND NEW.status IN ('succeeded','failed','cancelled','timed_out','dead_letter','skipped'))
 OR (OLD.status = 'failed'      AND NEW.status IN ('running','dead_letter'))
 OR (OLD.status = 'timed_out'   AND NEW.status IN ('running','dead_letter'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_state_transition');
END;
