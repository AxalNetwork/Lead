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

-- Durable job/error log for dispatch + scoring failures. Surfaces
-- SLO violations to operators ("re-match within minutes" is only
-- meaningful if failures are visible). Trimmed periodically by the
-- existing log-retention housekeeping job.
CREATE TABLE IF NOT EXISTS persona_match_jobs (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,       -- dispatch|score_entity|score_batch|score_across_personas|refresh_stale|trigger
  status      TEXT NOT NULL,       -- ok|halted|failed|cancelled
  persona_id  TEXT,
  entity_id   TEXT,
  details_json TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pmj_created  ON persona_match_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pmj_persona  ON persona_match_jobs(persona_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pmj_failures ON persona_match_jobs(status, created_at DESC) WHERE status != 'ok';

-- Safety stubs: in unusual out-of-order migration runs the backfill
-- below references three tables that come from older migrations
-- (170_personas.sql → persona_matches; 280_entities_legacy_map.sql →
-- entity_legacy_map; 200_entities.sql → u_entities). The
-- expected migration order in production is 170 → 200 → 280 → 331,
-- so these stubs are normally no-ops. They exist purely so a
-- partially-migrated dev DB can still apply 331 without raising
-- "no such table". The real migrations use richer schemas + their
-- own indexes; CREATE TABLE IF NOT EXISTS is a no-op when the
-- canonical table is already present.
--
-- Operators: if you see these stub tables being created in your
-- migration log, your DB is out of canonical order — apply 170, 200,
-- and 280 before 331 to get the full schema. The backfill is
-- additive and safe to re-run after the canonical tables land.
CREATE TABLE IF NOT EXISTS persona_matches (
  persona_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fit_score REAL,
  components_json TEXT,
  PRIMARY KEY (persona_id, entity_kind, entity_id)
);
CREATE TABLE IF NOT EXISTS entity_legacy_map (
  legacy_table TEXT NOT NULL,
  legacy_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  PRIMARY KEY (legacy_table, legacy_id)
);
CREATE TABLE IF NOT EXISTS u_entities (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  primary_domain TEXT,
  kind TEXT,
  status TEXT
);

-- One-time backfill: copy any existing persona_matches rows (Task #46
-- accounts/buyers matcher) whose entity_id resolves to a u_entity into
-- the new entity matches table. Marked source='auto' with a sentinel
-- last_scored_at='1970-01-01' so the nightly refresh re-scores them
-- with the v1 entity-graph algorithm on first run. INSERT OR IGNORE
-- preserves any rows already present (e.g. operator-pinned manual
-- entries created after the migration ran on dev). Greenfield deploys
-- get a no-op since persona_matches is empty.
INSERT OR IGNORE INTO persona_entity_matches (
  persona_id, entity_id, score, match_evidence_json, source,
  last_scored_at, model_version, created_at
)
SELECT
  pm.persona_id,
  elm.entity_id,
  COALESCE(pm.fit_score, 0) / 100.0,
  json_object('backfill_from','persona_matches','legacy_kind',pm.entity_kind,'legacy_components',pm.components_json,'legacy_fit_score',pm.fit_score),
  'auto',
  '1970-01-01T00:00:00Z',
  'v0-backfill',
  datetime('now')
FROM persona_matches pm
JOIN entity_legacy_map elm
  ON elm.legacy_table = CASE pm.entity_kind WHEN 'account' THEN 'accounts' WHEN 'buyer' THEN 'buyers' ELSE pm.entity_kind END
 AND elm.legacy_id = pm.entity_id
JOIN u_entities ue ON ue.id = elm.entity_id
WHERE ue.kind = 'person' AND ue.status = 'active';
