-- Task #6: Diligence Checklist Runner.
--
-- Migration numbering: spec text said 360, but slots 360-370 are all
-- taken (per the Task #13/#14/#18/#2/#3/#4/#5 contract-update precedent
-- in replit.md). This lands at 371, the next free slot. Future
-- migrations should number from 372.
--
-- Three tables:
--   1. diligence_templates      — owner-scoped (or system) ordered
--                                  list of check_keys the runner
--                                  dispatches against a target.
--   2. diligence_runs           — one row per run instance. Re-runs
--                                  do NOT mutate this row; "Re-run
--                                  failed checks" creates a NEW
--                                  diligence_runs row with
--                                  parent_run_id set so the chain
--                                  is auditable.
--   3. diligence_check_results  — append-only per (run_id, check_key).
--                                  Long-lived findings supersede via
--                                  the run-id chain — never via
--                                  in-place mutation.
--
-- Per the Task #1 canonical write contract, every derived business
-- fact emitted by a check executor (diligence.corporate.delaware_confirmed,
-- diligence.founder.education_verified, …) flows through `insertFact`
-- with source_kind="enrichment" and source="diligence:<check_key>" —
-- never directly into facts from SQL.

CREATE TABLE IF NOT EXISTS diligence_templates (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  description         TEXT,
  owner_email         TEXT,                  -- NULL for system templates (the seeded 'default')
  is_system           INTEGER NOT NULL DEFAULT 0,
  check_keys_json     TEXT NOT NULL,         -- ordered ["section.check_key", …]
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dt_owner ON diligence_templates(owner_email);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dt_system_name ON diligence_templates(name) WHERE is_system = 1;

CREATE TABLE IF NOT EXISTS diligence_runs (
  id                  TEXT PRIMARY KEY,
  template_id         TEXT NOT NULL,
  target_entity_id    TEXT NOT NULL,
  triggered_by        TEXT NOT NULL,         -- email
  status              TEXT NOT NULL DEFAULT 'queued', -- queued|running|completed|failed
  overall_score       REAL,                  -- 0..100; null until completed
  checks_total        INTEGER NOT NULL DEFAULT 0,
  checks_completed    INTEGER NOT NULL DEFAULT 0,
  by_status_json      TEXT,                  -- {"pass":12,"fail":3,"caution":2,"n/a":4,"needs_human":1}
  parent_run_id       TEXT,                  -- set for "rerun failed" runs
  started_at          TEXT,
  finished_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id)   REFERENCES diligence_templates(id),
  FOREIGN KEY (parent_run_id) REFERENCES diligence_runs(id)
);
CREATE INDEX IF NOT EXISTS idx_dr_target ON diligence_runs(target_entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dr_owner  ON diligence_runs(triggered_by, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dr_parent ON diligence_runs(parent_run_id);
CREATE INDEX IF NOT EXISTS idx_dr_status ON diligence_runs(status, created_at DESC);

CREATE TABLE IF NOT EXISTS diligence_check_results (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL,
  check_key           TEXT NOT NULL,
  section             TEXT NOT NULL,         -- corporate|founders|market|product|traction|team|regulatory|financial|ip
  title               TEXT NOT NULL,
  status              TEXT NOT NULL,         -- pass|fail|caution|n/a|needs_human
  severity            TEXT NOT NULL,         -- low|medium|high|critical
  confidence          REAL NOT NULL DEFAULT 0.5,
  finding_md          TEXT NOT NULL,
  evidence_json       TEXT,                  -- JSON-encoded ["https://…", …]
  flagged_for_human   INTEGER NOT NULL DEFAULT 0,
  duration_ms         INTEGER,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (run_id) REFERENCES diligence_runs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_dcr_run     ON diligence_check_results(run_id);
CREATE INDEX IF NOT EXISTS idx_dcr_status  ON diligence_check_results(run_id, status);
CREATE INDEX IF NOT EXISTS idx_dcr_section ON diligence_check_results(run_id, section);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dcr_run_check ON diligence_check_results(run_id, check_key);
