-- Task #8: ML Quality Ops harness.
--
-- Migration numbering: spec said 366, but slots 350-372 are all taken
-- (per the Task #13/#14/#18/#2/#3/#4/#5/#6 contract-update precedent
-- in replit.md) and 373 was claimed by the Task #6 production D1
-- dashboard_snapshots repair. This lands at 374, the next free slot.
-- Future migrations should number from 375.
--
-- Six cooperating tables:
--
--   1. eval_datasets    — one row per named labeled gold set; bumping
--                         labels creates a new row (`schema_version`)
--                         rather than mutating examples.
--   2. eval_examples    — append-only labeled rows; (dataset_id,
--                         example_key) unique so the JSON loader is
--                         idempotent.
--   3. eval_runs        — append-only per (dataset, prompt_version_id,
--                         model_version) run; carries metrics_json +
--                         a sample_predictions_json blob for spot-
--                         check / regression diffing.
--   4. prompt_versions  — append-only per (prompt_key, version);
--                         exactly one row has active=1 per prompt_key
--                         and that's the row getPrompt() returns.
--                         rollout_pct supports A/B routing: when
--                         < 100, a deterministic hash of
--                         (prompt_key, entity_id) gates the new
--                         version vs. the prior active.
--   5. prediction_outcomes_calibration
--                       — one row per (prediction_type, day_bucket)
--                         carrying Brier score, log-loss, and
--                         sample size for the day's graded
--                         predictions; per-type sparkline reads
--                         from this table.
--   6. hallucination_flags
--                       — append-only sink for AI-extracted facts
--                         whose source_span fails the verifier
--                         (empty span, or normalized span doesn't
--                         contain / fuzzy-match the claim's key
--                         tokens at >=0.7). NEVER mutates `facts`;
--                         the row never reached insertFact in the
--                         first place.

CREATE TABLE IF NOT EXISTS eval_datasets (
  id                  TEXT PRIMARY KEY,
  task_key            TEXT NOT NULL,    -- 'page_classification' | 'csv_mapping' | 'role_inference' | 'deal_extraction' | 'entity_dedupe' | 'founder_background'
  name                TEXT NOT NULL,
  schema_version      INTEGER NOT NULL DEFAULT 1,
  description         TEXT,
  active              INTEGER NOT NULL DEFAULT 1,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_eval_datasets_task_ver
  ON eval_datasets(task_key, schema_version);
CREATE INDEX IF NOT EXISTS idx_eval_datasets_active
  ON eval_datasets(active, task_key);

CREATE TABLE IF NOT EXISTS eval_examples (
  id                  TEXT PRIMARY KEY,
  dataset_id          TEXT NOT NULL REFERENCES eval_datasets(id) ON DELETE CASCADE,
  example_key         TEXT NOT NULL,
  input_json          TEXT NOT NULL,
  gold_output_json    TEXT NOT NULL,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_eval_examples_key
  ON eval_examples(dataset_id, example_key);
CREATE INDEX IF NOT EXISTS idx_eval_examples_dataset
  ON eval_examples(dataset_id);

CREATE TABLE IF NOT EXISTS eval_runs (
  id                       TEXT PRIMARY KEY,
  dataset_id               TEXT NOT NULL REFERENCES eval_datasets(id),
  task_key                 TEXT NOT NULL,
  prompt_version_id        TEXT,
  prompt_key               TEXT,
  prompt_version           TEXT,
  model_version            TEXT,
  status                   TEXT NOT NULL DEFAULT 'ok',  -- ok | unconfigured | error
  status_reason            TEXT,
  metrics_json             TEXT,                         -- {accuracy, precision, recall, f1, brier, ...}
  sample_predictions_json  TEXT,                         -- bounded sample for diff
  n_examples               INTEGER NOT NULL DEFAULT 0,
  n_correct                INTEGER NOT NULL DEFAULT 0,
  duration_ms              INTEGER,
  triggered_by             TEXT,                         -- 'manual' | 'nightly' | 'ci'
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_eval_runs_dataset_created
  ON eval_runs(dataset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_task_created
  ON eval_runs(task_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_prompt
  ON eval_runs(prompt_version_id);

CREATE TABLE IF NOT EXISTS prompt_versions (
  id              TEXT PRIMARY KEY,
  prompt_key      TEXT NOT NULL,
  version         TEXT NOT NULL,
  body            TEXT NOT NULL,
  model_hint      TEXT,
  notes           TEXT,
  active          INTEGER NOT NULL DEFAULT 0,
  rollout_pct     INTEGER NOT NULL DEFAULT 100,       -- 0..100; A/B knob
  previous_id     TEXT REFERENCES prompt_versions(id),
  created_by      TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_at     TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_versions_key_ver
  ON prompt_versions(prompt_key, version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_prompt_versions_active
  ON prompt_versions(prompt_key) WHERE active = 1;
CREATE INDEX IF NOT EXISTS idx_prompt_versions_key
  ON prompt_versions(prompt_key, created_at DESC);

CREATE TABLE IF NOT EXISTS prediction_outcomes_calibration (
  id                  TEXT PRIMARY KEY,
  prediction_type     TEXT NOT NULL,
  day_bucket          TEXT NOT NULL,                  -- YYYY-MM-DD
  sample_size         INTEGER NOT NULL,
  brier_score         REAL,
  log_loss            REAL,
  mean_predicted      REAL,
  mean_actual         REAL,
  payload_json        TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pred_cal_type_day
  ON prediction_outcomes_calibration(prediction_type, day_bucket);
CREATE INDEX IF NOT EXISTS idx_pred_cal_type_created
  ON prediction_outcomes_calibration(prediction_type, day_bucket DESC);

CREATE TABLE IF NOT EXISTS hallucination_flags (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT,
  predicate       TEXT NOT NULL,
  claim_text      TEXT NOT NULL,
  source_span     TEXT,                                 -- the text the extractor cited (may be empty)
  source_url      TEXT,
  source_kind     TEXT,
  extractor       TEXT,                                 -- e.g. 'deal_extractor:v1'
  prompt_version_id TEXT REFERENCES prompt_versions(id),
  fail_reason     TEXT NOT NULL,                        -- 'empty_span' | 'span_not_in_source' | 'claim_not_in_span' | 'low_fuzzy'
  fuzzy_score     REAL,
  raw_extraction_json TEXT,
  reviewed        INTEGER NOT NULL DEFAULT 0,
  reviewer_email  TEXT,
  reviewed_at     TEXT,
  reviewer_verdict TEXT,                                -- 'true_hallucination' | 'false_positive' | 'unclear'
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_hf_created
  ON hallucination_flags(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hf_extractor
  ON hallucination_flags(extractor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hf_unreviewed
  ON hallucination_flags(reviewed, created_at DESC);
