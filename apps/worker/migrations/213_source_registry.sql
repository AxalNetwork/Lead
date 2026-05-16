-- Task #5: Source registry & scheduled re-crawl.
--
-- Today every list URL the user has ever imported lives in scattered
-- seed files and ad-hoc job rows. This migration introduces a single
-- `source_registry` table as the source of truth for every recurring
-- import target, plus a per-source run-history table and freshness
-- columns on `u_entities` so we can flag entities that haven't been
-- seen on any source for >90 days as "likely_dead".
--
-- The cron at `0 */6 * * *` picks every row whose `next_run_after` has
-- passed (or is null), enqueues a firmlist job carrying
-- `source_registry_id` in `config_json`, updates `last_run_at` /
-- `last_run_status='running'`, and advances `next_run_after`. The
-- pipeline writes back success/failure stats and stamps
-- `last_seen_source_at` on every touched entity so the staleness sweep
-- has accurate data to work with.

CREATE TABLE IF NOT EXISTS source_registry (
  id TEXT PRIMARY KEY,
  -- The URL exactly as the operator pasted it. Kept verbatim so the
  -- dashboard can show what was registered.
  url TEXT NOT NULL,
  -- Lowercased, trailing-slash-stripped canonical form used for the
  -- unique constraint. Lets us dedupe `https://Example.com/` and
  -- `https://example.com`.
  url_canonical TEXT NOT NULL UNIQUE,
  url_host TEXT NOT NULL,
  -- Importer module name (`folk`, `airtable`, `wikipedia`, etc).
  -- Auto-detected at insert time; the operator can override later.
  importer TEXT NOT NULL,
  -- Optional per-importer config (variant, role_hint, country, region,
  -- record_type, etc). Mirrors the `hints` block from seed-sources.json.
  importer_config_json TEXT,
  label TEXT,
  category TEXT,
  region TEXT,
  role_hint TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Cron expression. Default '0 */6 * * *' (every 6 hours) matches the
  -- scheduled re-crawl tick. Sources may opt into different cadences
  -- (e.g. nightly for big Wikipedia pages, weekly for static lists).
  schedule_cron TEXT NOT NULL DEFAULT '0 */6 * * *',
  last_run_at TEXT,
  last_success_at TEXT,
  -- 'idle' | 'running' | 'succeeded' | 'partial' | 'failed'
  last_run_status TEXT NOT NULL DEFAULT 'idle',
  last_run_job_id TEXT,
  records_seen_last INTEGER NOT NULL DEFAULT 0,
  records_created_last INTEGER NOT NULL DEFAULT 0,
  records_updated_last INTEGER NOT NULL DEFAULT 0,
  records_unchanged_last INTEGER NOT NULL DEFAULT 0,
  records_errors_last INTEGER NOT NULL DEFAULT 0,
  -- Cumulative counters across every run.
  total_runs INTEGER NOT NULL DEFAULT 0,
  total_success INTEGER NOT NULL DEFAULT 0,
  total_failed INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  next_run_after TEXT,
  notes TEXT,
  added_by TEXT,
  added_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_source_registry_due
  ON source_registry(enabled, next_run_after);
CREATE INDEX IF NOT EXISTS idx_source_registry_importer
  ON source_registry(importer);
CREATE INDEX IF NOT EXISTS idx_source_registry_host
  ON source_registry(url_host);
CREATE INDEX IF NOT EXISTS idx_source_registry_status
  ON source_registry(last_run_status);

-- Per-run history. One row inserted at enqueue time, updated by the
-- pipeline on completion. The dashboard side-drawer reads the last
-- 30 rows for the per-source run-history chart.
CREATE TABLE IF NOT EXISTS source_registry_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source_registry(id) ON DELETE CASCADE,
  job_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',  -- running|succeeded|partial|failed|skipped
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_created INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  records_unchanged INTEGER NOT NULL DEFAULT 0,
  records_errors INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  trigger TEXT NOT NULL DEFAULT 'cron'      -- cron|manual|run_all|first_deploy
);

CREATE INDEX IF NOT EXISTS idx_source_runs_source
  ON source_registry_runs(source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_runs_job
  ON source_registry_runs(job_id);

-- Freshness propagation on the unified entity graph. Updated by the
-- pipeline whenever a source run touches an entity (created/updated).
-- The nightly staleness sweep flags entities not seen for >90 days as
-- `staleness='likely_dead'`; admins can clear it manually.
ALTER TABLE u_entities ADD COLUMN last_seen_source_at TEXT;
ALTER TABLE u_entities ADD COLUMN staleness TEXT;

CREATE INDEX IF NOT EXISTS idx_entities_last_seen_source
  ON u_entities(last_seen_source_at);
CREATE INDEX IF NOT EXISTS idx_entities_staleness
  ON u_entities(staleness) WHERE staleness IS NOT NULL;
