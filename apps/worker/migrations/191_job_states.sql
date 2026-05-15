-- Task #27: explicit job state machine.
--
-- Existing `jobs.status` already uses string states (queued/running/done/
-- error/cancelled/blocked). This migration formalizes the transitions table
-- and a per-job last_error pointer so the UI can show "why did this job
-- fail?" without scanning the full error_log.

ALTER TABLE jobs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN last_error_id INTEGER REFERENCES error_log(id) ON DELETE SET NULL;
ALTER TABLE jobs ADD COLUMN last_error_code TEXT;
ALTER TABLE jobs ADD COLUMN last_error_at TEXT;
ALTER TABLE jobs ADD COLUMN replay_of TEXT REFERENCES jobs(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS job_state_transitions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id      TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT NOT NULL,
  reason      TEXT,
  changed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  changed_by  TEXT
);

CREATE INDEX IF NOT EXISTS idx_job_state_trans_job ON job_state_transitions(job_id, changed_at);

CREATE INDEX IF NOT EXISTS idx_jobs_last_error_at ON jobs(last_error_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_replay_of    ON jobs(replay_of);
