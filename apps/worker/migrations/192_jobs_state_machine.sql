-- Task #27: strict job state machine + extended error_log fields.
--
-- jobs.status now uses a strict CHECK constraint covering:
--   queued -> running -> succeeded | failed | cancelled | timed_out | dead_letter
-- and `retry_count >= 5` => `dead_letter` is enforced by the queue handler in
-- src/index.ts.
--
-- error_log gains workflow_run_id / host / user_email / retry_count so the
-- dashboard can cluster failures by host or by Cloudflare Workflow run.

-- 1. Replace jobs.status CHECK by rebuilding the column (D1/SQLite path).

ALTER TABLE jobs ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN status_v2 TEXT NOT NULL DEFAULT 'queued'
  CHECK (status_v2 IN ('queued','running','succeeded','failed','cancelled','timed_out','dead_letter','blocked'));

-- Migrate existing values (including the legacy 'done' alias and 'error').
UPDATE jobs SET status_v2 = CASE
  WHEN status = 'done'      THEN 'succeeded'
  WHEN status = 'success'   THEN 'succeeded'
  WHEN status = 'error'     THEN 'failed'
  WHEN status IN ('queued','running','succeeded','failed','cancelled','timed_out','dead_letter','blocked')
    THEN status
  ELSE 'failed'
END;

-- We keep `status` as the live column for backward compat with the existing
-- dashboard queries. Mirror status_v2 back into status and drop the helper.
UPDATE jobs SET status = status_v2;

-- Note: we cannot DROP COLUMN in older D1 SQLite without a table rebuild;
-- leaving status_v2 in place is harmless and makes the constraint enforceable
-- via a trigger.
CREATE TRIGGER IF NOT EXISTS trg_jobs_status_check
BEFORE UPDATE OF status ON jobs
FOR EACH ROW
WHEN NEW.status NOT IN ('queued','running','succeeded','failed','cancelled','timed_out','dead_letter','blocked')
BEGIN
  SELECT RAISE(ABORT, 'invalid_job_status');
END;

CREATE TRIGGER IF NOT EXISTS trg_jobs_status_check_ins
BEFORE INSERT ON jobs
FOR EACH ROW
WHEN NEW.status NOT IN ('queued','running','succeeded','failed','cancelled','timed_out','dead_letter','blocked')
BEGIN
  SELECT RAISE(ABORT, 'invalid_job_status');
END;

-- 2. parent_job_id rename (was `replay_of` in 191).
ALTER TABLE jobs ADD COLUMN parent_job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL;
UPDATE jobs SET parent_job_id = replay_of WHERE replay_of IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_jobs_parent ON jobs(parent_job_id);

-- 3. Extended error_log fields.
ALTER TABLE error_log ADD COLUMN workflow_run_id TEXT;
ALTER TABLE error_log ADD COLUMN host            TEXT;
ALTER TABLE error_log ADD COLUMN user_email      TEXT;
ALTER TABLE error_log ADD COLUMN retry_count     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE error_log ADD COLUMN resolved_at     TEXT;
ALTER TABLE error_log ADD COLUMN resolved_by     TEXT;

CREATE INDEX IF NOT EXISTS idx_error_log_host       ON error_log(host, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_workflow   ON error_log(workflow_run_id);
CREATE INDEX IF NOT EXISTS idx_error_log_resolved   ON error_log(resolved_at);
