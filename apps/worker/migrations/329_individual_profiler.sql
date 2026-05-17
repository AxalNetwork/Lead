-- Task #5: Advanced Individual Profiler.
--
-- Three operational tables. NONE of these are new "structured signal"
-- tables — those all live in 327_rich_person_profile.sql and are written
-- only via EntityService helpers. These are workflow-ops + the final
-- synthesis artifact called out in step 10 of the task spec.
--
--   1. profiler_runs            — one row per IndividualProfilerWorkflow
--                                 dispatch. Status, totals, who triggered.
--   2. profiler_enricher_logs   — one row per enricher per run, with
--                                 {neurons, fetches, bytes, wall_ms,
--                                 est_usd} per the task contract.
--   3. person_dossier_synthesis — the computed `to_do_business_with_them`
--                                 dossier keyed on (entity_id, computed_at).
--                                 The dossier endpoint reads the latest row.

CREATE TABLE IF NOT EXISTS profiler_runs (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  workflow_run_id TEXT,
  status          TEXT NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','running','succeeded','failed','partial','privacy_skip')),
  triggered_by    TEXT NOT NULL,
  force_refresh   INTEGER NOT NULL DEFAULT 0,
  respects_privacy INTEGER NOT NULL DEFAULT 0,
  privacy_reasons_json TEXT,
  enricher_count  INTEGER NOT NULL DEFAULT 0,
  writes_count    INTEGER NOT NULL DEFAULT 0,
  failed_count    INTEGER NOT NULL DEFAULT 0,
  skipped_count   INTEGER NOT NULL DEFAULT 0,
  total_neurons   REAL NOT NULL DEFAULT 0,
  total_est_usd   REAL NOT NULL DEFAULT 0,
  total_wall_ms   INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_profiler_runs_entity_started
  ON profiler_runs(entity_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_profiler_runs_status
  ON profiler_runs(status, started_at DESC);

CREATE TABLE IF NOT EXISTS profiler_enricher_logs (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL,
  entity_id     TEXT NOT NULL,
  enricher_name TEXT NOT NULL,
  category      TEXT NOT NULL,
  status        TEXT NOT NULL
                CHECK (status IN ('pending','running','done','skipped','failed')),
  skipped_reason TEXT,
  error         TEXT,
  writes_count  INTEGER NOT NULL DEFAULT 0,
  neurons       REAL NOT NULL DEFAULT 0,
  fetches       INTEGER NOT NULL DEFAULT 0,
  bytes         INTEGER NOT NULL DEFAULT 0,
  wall_ms       INTEGER NOT NULL DEFAULT 0,
  est_usd       REAL NOT NULL DEFAULT 0,
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  FOREIGN KEY (run_id) REFERENCES profiler_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_profiler_enricher_logs_run
  ON profiler_enricher_logs(run_id, enricher_name);
CREATE UNIQUE INDEX IF NOT EXISTS uq_profiler_enricher_logs_run_name
  ON profiler_enricher_logs(run_id, enricher_name);

CREATE TABLE IF NOT EXISTS person_dossier_synthesis (
  id                       TEXT PRIMARY KEY,
  entity_id                TEXT NOT NULL,
  run_id                   TEXT,
  computed_at              TEXT NOT NULL,
  to_do_business_with_them_json TEXT NOT NULL,  -- the dossier section
  conversation_starters_count   INTEGER NOT NULL DEFAULT 0,
  warm_intro_paths_count        INTEGER NOT NULL DEFAULT 0,
  citations_count               INTEGER NOT NULL DEFAULT 0,
  llm_model                TEXT,
  llm_neurons              REAL NOT NULL DEFAULT 0,
  notes                    TEXT
);
CREATE INDEX IF NOT EXISTS idx_dossier_entity_computed
  ON person_dossier_synthesis(entity_id, computed_at DESC);

-- Last-run pointer for quick KV cache invalidation by entity_id.
CREATE INDEX IF NOT EXISTS idx_dossier_run ON person_dossier_synthesis(run_id);
