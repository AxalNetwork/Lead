-- Task #8: Real persona matching algorithm.
--
-- Adds a second persona match table that scores persona definitions
-- against the unified `u_entities` graph (person entities specifically:
-- founders, operators, executives) along the v8 component set:
--   title_sim, seniority, function, industry, company_size, stage, geo.
--
-- This table is SEPARATE from `persona_matches` (migration 170) which
-- scores against the legacy `accounts`/`buyers` tables from Task #46.
-- The two layers coexist: dashboards keep using persona_matches for
-- prospect-DB scoring; this table powers `/api/personas/:id/candidates`
-- which ranks entities in the unified graph.
--
-- Manual rows carry `source='manual'`; algorithmic rows carry
-- `source='auto'`. The persona-entity matcher never overwrites manual
-- rows.
CREATE TABLE IF NOT EXISTS persona_entity_matches (
  persona_id          TEXT NOT NULL,
  entity_id           TEXT NOT NULL,
  score               REAL NOT NULL DEFAULT 0,          -- 0..1 weighted aggregate
  match_evidence_json TEXT,                              -- {components, rationale, weights, version}
  source              TEXT NOT NULL DEFAULT 'auto',      -- 'manual' | 'auto'
  last_scored_at      TEXT NOT NULL DEFAULT (datetime('now')),
  model_version       TEXT NOT NULL DEFAULT 'v1',
  created_at          TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (persona_id, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_pem_persona_score
  ON persona_entity_matches(persona_id, score DESC);
CREATE INDEX IF NOT EXISTS idx_pem_entity
  ON persona_entity_matches(entity_id);
CREATE INDEX IF NOT EXISTS idx_pem_stale
  ON persona_entity_matches(last_scored_at);
CREATE INDEX IF NOT EXISTS idx_pem_source
  ON persona_entity_matches(persona_id, source);
