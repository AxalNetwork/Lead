-- Task #4: Fix projects auto-matching.
--
-- Audience-typed projection of project_matches with a 7-day TTL plus a
-- persistent negative-feedback table that the matcher applies as a
-- score penalty. The matcher itself (services/projects/audienceMatcher.ts)
-- runs the existing two-phase pipeline (project_matches), then mirrors
-- the top-50 per audience into this table with `expires_at = computed_at + 7d`.
--
-- Audience names here use the plural surface form exposed by the API
-- (`customers`, `investors`, `partners`, `hires`, `design`) — the
-- service layer maps these to the internal singular form used by the
-- legacy `project_matches` table.

CREATE TABLE IF NOT EXISTS project_audience_matches (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id           TEXT    NOT NULL,
  audience             TEXT    NOT NULL,        -- customers|investors|partners|hires|design
  entity_kind          TEXT    NOT NULL,        -- lead|account|firm|company (source table)
  entity_id            TEXT    NOT NULL,
  match_score          REAL    NOT NULL DEFAULT 0,   -- 0..1
  embedding_similarity REAL    NOT NULL DEFAULT 0,
  criteria_overlap     REAL    NOT NULL DEFAULT 0,
  recency_bonus        REAL    NOT NULL DEFAULT 0,
  feedback_penalty     REAL    NOT NULL DEFAULT 0,
  score_breakdown_json TEXT,
  reason               TEXT,                    -- short human-readable explainer
  computed_at          TEXT    NOT NULL DEFAULT (datetime('now')),
  expires_at           TEXT    NOT NULL,        -- computed_at + 7d
  UNIQUE (project_id, audience, entity_kind, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_pam_project_audience_score
  ON project_audience_matches(project_id, audience, match_score DESC);
CREATE INDEX IF NOT EXISTS idx_pam_expires
  ON project_audience_matches(expires_at);
CREATE INDEX IF NOT EXISTS idx_pam_entity
  ON project_audience_matches(entity_kind, entity_id);

-- Negative-feedback table. `Mark not relevant` writes one row per
-- (project, audience, entity); the matcher reads these on every
-- re-score and subtracts `weight` from the candidate's match_score
-- (clamped at 0). Persistent across recomputes by design.
CREATE TABLE IF NOT EXISTS project_audience_feedback (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id        TEXT    NOT NULL,
  audience          TEXT    NOT NULL,
  entity_kind       TEXT    NOT NULL,
  entity_id         TEXT    NOT NULL,
  signal            TEXT    NOT NULL DEFAULT 'not_relevant',
  weight            REAL    NOT NULL DEFAULT 0.5,    -- subtracted from match_score
  created_by_email  TEXT,
  created_at        TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (project_id, audience, entity_kind, entity_id, signal)
);

CREATE INDEX IF NOT EXISTS idx_paf_project_audience
  ON project_audience_feedback(project_id, audience);
