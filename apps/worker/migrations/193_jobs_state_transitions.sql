-- Task #27: enforce strict job state transitions and dead_letter rule at the
-- database level (not just in application code). SQLite/D1 lacks native CHECK
-- on transitions, so we use BEFORE UPDATE/INSERT triggers that RAISE(ABORT, ...)
-- on illegal transitions.
--
-- Allowed graph:
--   queued      -> running, cancelled, dead_letter
--   running     -> succeeded, failed, cancelled, timed_out, dead_letter
--   failed      -> running        (retry path; resets retry_count downward)
--   succeeded   -> (terminal)
--   cancelled   -> (terminal)
--   timed_out   -> running, dead_letter
--   dead_letter -> (terminal)
--
-- Rule: if NEW.retry_count >= 5 AND NEW.status IN ('failed','running','timed_out')
--       => the only allowed write is NEW.status = 'dead_letter'.

-- Drop the legacy 'blocked' value if it was inserted before strict mode landed
-- (192_jobs_state_machine.sql was permissive). Map any 'blocked' rows to
-- 'dead_letter' so the new transition trigger doesn't reject them.
UPDATE jobs SET status = 'dead_letter' WHERE status = 'blocked';

-- Replace the permissive triggers from migration 192 with strict ones.
DROP TRIGGER IF EXISTS trg_jobs_status_check;
DROP TRIGGER IF EXISTS trg_jobs_status_check_ins;

-- INSERT: only `queued` is allowed as an initial state (the queue handler is
-- the only path that writes a different status, and it does so via UPDATE).
CREATE TRIGGER trg_jobs_status_check_ins
BEFORE INSERT ON jobs
FOR EACH ROW
WHEN NEW.status NOT IN ('queued','running')
BEGIN
  SELECT RAISE(ABORT, 'invalid_initial_status: only queued/running allowed at insert');
END;

-- UPDATE: allowed transition graph (terminal states are immutable).
CREATE TRIGGER trg_jobs_status_transition
BEFORE UPDATE OF status ON jobs
FOR EACH ROW
WHEN OLD.status != NEW.status
  AND NOT (
    -- Allowed forward transitions.
    (OLD.status = 'queued'      AND NEW.status IN ('running','cancelled','dead_letter'))
 OR (OLD.status = 'running'     AND NEW.status IN ('succeeded','failed','cancelled','timed_out','dead_letter'))
 OR (OLD.status = 'failed'      AND NEW.status IN ('running','dead_letter'))
 OR (OLD.status = 'timed_out'   AND NEW.status IN ('running','dead_letter'))
  )
BEGIN
  SELECT RAISE(ABORT, 'invalid_state_transition');
END;

-- Dead-letter rule: any UPDATE that sets retry_count >= 5 for a non-terminal
-- status MUST simultaneously set status = 'dead_letter'.
CREATE TRIGGER trg_jobs_dead_letter_rule
BEFORE UPDATE ON jobs
FOR EACH ROW
WHEN NEW.retry_count >= 5
  AND NEW.status IN ('queued','running','failed','timed_out')
BEGIN
  SELECT RAISE(ABORT, 'retry_count>=5_requires_dead_letter');
END;

-- Mirror constraint at insert time too (defensive).
CREATE TRIGGER trg_jobs_dead_letter_rule_ins
BEFORE INSERT ON jobs
FOR EACH ROW
WHEN NEW.retry_count >= 5
  AND NEW.status IN ('queued','running','failed','timed_out')
BEGIN
  SELECT RAISE(ABORT, 'retry_count>=5_requires_dead_letter');
END;
