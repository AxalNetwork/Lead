-- Task #27: centralized error log + workflow step diagnostics.
--
-- error_log: every AppError surfaced via the worker (HTTP 5xx, queue retries,
-- scheduled handler crashes, queue consumer failures). Indexed for fast UI
-- filtering by code/kind/job_id/time.
--
-- workflow_step_log: one row per top-level pipeline step
-- (fetch_html, parse_team, dedupe, enrich:hunter, ai:extract, …) with timing,
-- counts, and the error that aborted it (if any). Lets the dashboard render a
-- step-by-step diagnosis of any job.

CREATE TABLE IF NOT EXISTS error_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  request_id  TEXT,
  job_id      TEXT,
  step        TEXT,
  code        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  status      INTEGER NOT NULL DEFAULT 500,
  retryable   INTEGER NOT NULL DEFAULT 0,
  message     TEXT,
  context_json TEXT,
  cause_name  TEXT,
  cause_message TEXT,
  cause_stack TEXT,
  url         TEXT,
  method      TEXT
);

CREATE INDEX IF NOT EXISTS idx_error_log_time   ON error_log(occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_code   ON error_log(code, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_kind   ON error_log(kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_job    ON error_log(job_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_error_log_req    ON error_log(request_id);

CREATE TABLE IF NOT EXISTS workflow_step_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       TEXT NOT NULL,
  step         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('started','ok','warn','error','skipped')),
  started_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  finished_at  TEXT,
  duration_ms  INTEGER,
  count_in     INTEGER,
  count_out    INTEGER,
  error_id     INTEGER REFERENCES error_log(id) ON DELETE SET NULL,
  meta_json    TEXT
);

CREATE INDEX IF NOT EXISTS idx_step_log_job  ON workflow_step_log(job_id, started_at);
CREATE INDEX IF NOT EXISTS idx_step_log_step ON workflow_step_log(step, started_at DESC);
