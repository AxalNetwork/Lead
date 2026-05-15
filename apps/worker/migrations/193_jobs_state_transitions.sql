-- Task #27: enforce strict job state transitions and dead_letter rule at the
-- database level (not just in application code). SQLite/D1 lacks native CHECK
-- on transitions, so we use BEFORE UPDATE/INSERT triggers that RAISE(ABORT, ...)
-- on illegal transitions.
--
-- Allowed graph (we accept the legacy `completed` / `success` aliases of
-- `succeeded` so the existing scraper pipeline.markCompleted call stays valid
-- without a risky cross-cutting rename):
--   queued      -> running, cancelled, dead_letter
--   running     -> succeeded|completed|success, failed, cancelled, timed_out, dead_letter
--   failed      -> running, dead_letter
--   timed_out   -> running, dead_letter
--   succeeded|completed|success -> (terminal)
--   cancelled   -> (terminal)
--   dead_letter -> (terminal)
--
-- Rule: if NEW.retry_count >= 5 AND NEW.status is non-terminal,
--       the only allowed write is NEW.status = 'dead_letter'.

UPDATE jobs SET status = 'dead_letter' WHERE status = 'blocked';

-- Make sure the v2 CHECK column also accepts the legacy aliases so the
-- mirror UPDATE in pipeline.markCompleted() doesn't trip migration 192's
-- column constraint either.
DROP TRIGGER IF EXISTS trg_jobs_status_check;
DROP TRIGGER IF EXISTS trg_jobs_status_check_ins;

CREATE TRIGGER trg_jobs_status_check_ins
BEFORE INSERT ON jobs
FOR EACH ROW
WHEN NEW.status NOT IN ('queued','running')
BEGIN
  SELECT RAISE(ABORT, 'invalid_initial_status: only queued/running allowed at insert');
END;

CREATE TRIGGER trg_jobs_status_transition
BEFORE UPDATE OF status ON jobs
FOR EACH ROW
WHEN OLD.status != NEW.status
  AND NOT (
    (OLD.status = 'queued'      AND NEW.status IN ('running','cancelled','dead_letter'))
 OR (OLD.status = 'running'     AND NEW.status IN ('succeeded','completed','success','failed','cancelled','timed_out','dead_letter'))
 OR (OLD.status = 'failed'      AND NEW.status IN ('running','dead_letter'))
 OR (OLD.status = 'timed_out'   AND NEW.status IN ('running','dead_letter'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_state_transition');
END;

CREATE TRIGGER trg_jobs_dead_letter_rule
BEFORE UPDATE ON jobs
FOR EACH ROW
WHEN NEW.retry_count >= 5
  AND NEW.status IN ('queued','running','failed','timed_out')
BEGIN
  SELECT RAISE(ABORT, 'retry_count>=5_requires_dead_letter');
END;

CREATE TRIGGER trg_jobs_dead_letter_rule_ins
BEFORE INSERT ON jobs
FOR EACH ROW
WHEN NEW.retry_count >= 5
  AND NEW.status IN ('queued','running','failed','timed_out')
BEGIN
  SELECT RAISE(ABORT, 'retry_count>=5_requires_dead_letter');
END;

-- workflow_step_log: extend with the spec-required fields.
--   workflow_run_id  - Cloudflare Workflows run id (or queue batch id).
--   step_name        - canonical step name (alias of `step`, kept for spec parity).
--   attempt          - 1-based attempt counter for the step.
--   error_code       - denormalized ErrCode for fast cluster queries.
ALTER TABLE workflow_step_log ADD COLUMN workflow_run_id TEXT;
ALTER TABLE workflow_step_log ADD COLUMN step_name       TEXT;
ALTER TABLE workflow_step_log ADD COLUMN attempt         INTEGER NOT NULL DEFAULT 1;
ALTER TABLE workflow_step_log ADD COLUMN error_code      TEXT;

UPDATE workflow_step_log SET step_name = step WHERE step_name IS NULL;

CREATE INDEX IF NOT EXISTS idx_step_log_run  ON workflow_step_log(workflow_run_id, started_at);
CREATE INDEX IF NOT EXISTS idx_step_log_code ON workflow_step_log(error_code, started_at DESC);
