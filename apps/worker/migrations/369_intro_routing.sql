-- Task #4: Intro Routing Engine.
--
-- Migration numbering: spec said 354, but slots 350-368 are all taken
-- (see replit.md Task #13/#14/#18/#2/#3 contract-update notes). This
-- lands at 369, the next free slot. Future migrations should number
-- from 370.
--
-- Three cooperating tables:
--   1. intro_paths        — one row per ranked path returned by
--                            POST /api/intros/find. Append-only; the
--                            `id` is the stable handle log-outcome
--                            references later.
--   2. intro_outcomes     — append-only outcome log. One row per
--                            operator action (requested → made →
--                            accepted → meeting_held → deal_closed,
--                            or declined / ghosted). Drives the
--                            nightly retrain.
--   3. intro_model_runs   — one row per nightly retrain. Carries the
--                            persisted logistic weights + Brier
--                            calibration score so operators can see
--                            calibration drift over time. Exactly
--                            one row has is_current=1.
--
-- Per the Task #1 canonical write contract, every derived per-path
-- snapshot fact (entity.intro_predicted_conversion_pct) mirrors onto
-- the target entity via insertFact with source_kind="inferred"
-- (existing enum value, same precedent as Task #2/#3 model output).

CREATE TABLE IF NOT EXISTS intro_paths (
  id                        TEXT PRIMARY KEY,
  viewer_entity_id          TEXT,                       -- nullable when viewer is an operator email
  viewer_email              TEXT,                       -- operator who asked for the path
  target_entity_id          TEXT NOT NULL,
  ask_context               TEXT,                       -- free-text ask
  hops                      INTEGER NOT NULL,           -- 1..3
  path_json                 TEXT NOT NULL,              -- [{entity_id, display_name, edge_id, edge_kind, edge_quality}, ...]
  first_hop_entity_id       TEXT,                       -- denormalized: path[0] convenience
  weakest_edge_quality      REAL,                       -- min(edge.quality_score) along the path; NULL if any edge lacks a score
  predicted_conversion_pct  REAL,                       -- logistic predict in [0,1]; NULL when model is uncalibrated
  features_json             TEXT,                       -- {path_length, weakest_eq, target_pr, broker_in_path, ask_match}
  suggested_opener          TEXT,                       -- ≤60-word draft for the first hop
  model_version             TEXT,                       -- intro_model_runs.id of the model that scored this row
  ranking_mode              TEXT NOT NULL DEFAULT 'weighted',  -- 'weighted' | 'hop_count_only'
  created_at                TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_intro_paths_target ON intro_paths(target_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intro_paths_viewer ON intro_paths(viewer_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intro_paths_first  ON intro_paths(first_hop_entity_id);

CREATE TABLE IF NOT EXISTS intro_outcomes (
  id            TEXT PRIMARY KEY,
  path_id       TEXT NOT NULL,
  status        TEXT NOT NULL,    -- requested|made|accepted|declined|ghosted|meeting_held|deal_closed
  logged_by     TEXT,             -- operator email
  notes         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_intro_outcomes_path   ON intro_outcomes(path_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intro_outcomes_status ON intro_outcomes(status, created_at DESC);

CREATE TABLE IF NOT EXISTS intro_model_runs (
  id              TEXT PRIMARY KEY,
  trained_at      TEXT NOT NULL DEFAULT (datetime('now')),
  weights_json    TEXT NOT NULL,    -- {intercept, length, weakest_eq, target_pr, broker, ask_match}
  sample_size     INTEGER NOT NULL,
  brier_score     REAL,             -- mean squared error vs. observed 0/1 (lower is better)
  positives       INTEGER NOT NULL DEFAULT 0,
  negatives       INTEGER NOT NULL DEFAULT 0,
  notes           TEXT,
  is_current      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_intro_model_current ON intro_model_runs(is_current, trained_at DESC);
