-- Task #1: Per-Profile-Type Workflows.
--
-- profile_workflow_runs records every typed workflow execution: which
-- profile type ran, against which entity / candidate URL, what it cost
-- (sources fetched, AI neurons), and how many facts it wrote / verified.
-- The operator console (Task #2) reads from here for the per-type spend
-- roll-up; failing runs surface in the same view by status='failed'.
--
-- Also adds a `verified` boolean to `facts`. The workflow's cross-source
-- verifier promotes a fact to `verified=1` when ≥2 distinct sources
-- report a matching value; single-source facts persist with verified=0
-- and reduced confidence. The column is independent of `is_current` and
-- `confidence` so downstream queries can filter on any combination.

CREATE TABLE IF NOT EXISTS profile_workflow_runs (
  id                    TEXT PRIMARY KEY,
  workflow_id           TEXT NOT NULL,
  profile_type_id       TEXT NOT NULL,
  entity_id             TEXT,
  candidate_url         TEXT NOT NULL,
  candidate_host        TEXT,
  job_id                TEXT,
  status                TEXT NOT NULL,           -- 'success' | 'partial' | 'failed' | 'skipped'
  sources_planned       INTEGER NOT NULL DEFAULT 0,
  sources_fetched       INTEGER NOT NULL DEFAULT 0,
  sources_failed        INTEGER NOT NULL DEFAULT 0,
  facts_written         INTEGER NOT NULL DEFAULT 0,
  facts_verified        INTEGER NOT NULL DEFAULT 0,
  ai_calls              INTEGER NOT NULL DEFAULT 0,
  ai_neurons            REAL NOT NULL DEFAULT 0,
  estimated_cost_usd    REAL NOT NULL DEFAULT 0,
  actual_cost_usd       REAL NOT NULL DEFAULT 0,
  errors_json           TEXT,                    -- [{tag, message}]
  duration_ms           INTEGER NOT NULL DEFAULT 0,
  run_at                TEXT NOT NULL DEFAULT (datetime('now')),
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_pwr_type_time    ON profile_workflow_runs(profile_type_id, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_pwr_entity_time  ON profile_workflow_runs(entity_id, run_at DESC) WHERE entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_pwr_status_time  ON profile_workflow_runs(status, run_at DESC);
CREATE INDEX IF NOT EXISTS idx_pwr_workflow     ON profile_workflow_runs(workflow_id, run_at DESC);

-- facts.verified — workflow cross-source verification flag. SQLite has
-- no native boolean; 0/1 only. Default 0 preserves prior rows' shape;
-- legacy single-source writes via EntityService remain verified=0
-- which is the correct default for un-cross-referenced facts.
ALTER TABLE facts ADD COLUMN verified INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_facts_verified_current
  ON facts(entity_id, predicate) WHERE verified = 1 AND is_current = 1;
