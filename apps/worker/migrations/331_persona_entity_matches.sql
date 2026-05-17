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

-- Manual-match preservation table. Legacy `persona_matches` has no
-- source column, so operators who pinned manual overrides under the
-- pre-Task-#8 flow should populate this table (one row per manually
-- accepted match) BEFORE running migration 331; the backfill below
-- consults it to stamp those rows as source='manual' instead of 'auto'.
-- Greenfield deploys leave this table empty and the LEFT JOIN is a
-- no-op. Going forward, manual matches are written directly to
-- persona_entity_matches with source='manual' by the routes layer.
CREATE TABLE IF NOT EXISTS persona_match_manual_overrides (
  persona_id TEXT NOT NULL,
  entity_id  TEXT NOT NULL,
  PRIMARY KEY (persona_id, entity_id)
);

-- Hard-fail guard: if the legacy persona_matches table has ANY rows
-- but persona_match_manual_overrides is empty, abort the migration
-- with a division-by-zero so manual pins are not silently downgraded
-- to source='auto'. Operator must populate the overrides table first
-- (see PERSONA_MATCHING.md runbook). Greenfield deploys (legacy
-- empty) pass through cleanly.
SELECT CASE
  WHEN EXISTS (SELECT 1 FROM persona_matches LIMIT 1)
   AND NOT EXISTS (SELECT 1 FROM persona_match_manual_overrides LIMIT 1)
  THEN 1/0  -- ABORT: populate persona_match_manual_overrides before applying migration 331
  ELSE 0
END;

-- Persona/entity title-embedding caches. The matcher reads from these
-- BEFORE calling AI.embed, so per-entity scoring becomes a D1 lookup
-- on the hot path. content_hash invalidates the cache when the
-- underlying title text changes. This mirrors the Vectorize
-- precompute/reuse pattern used by Task #7 personas without
-- requiring a new Vectorize index.
CREATE TABLE IF NOT EXISTS persona_title_embeddings (
  persona_id    TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  vector_json   TEXT NOT NULL,        -- JSON array of 768 floats
  model         TEXT NOT NULL DEFAULT 'bge-base-en-v1.5',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS entity_title_embeddings (
  entity_id     TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL,
  vector_json   TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT 'bge-base-en-v1.5',
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pte_hash ON persona_title_embeddings(content_hash);
CREATE INDEX IF NOT EXISTS idx_ete_hash ON entity_title_embeddings(content_hash);

-- One-time backfill: copy any existing persona_matches rows (Task #46
-- accounts/buyers matcher) whose entity_id resolves to a u_entity into
-- the new entity matches table. source defaults to 'auto' with a
-- sentinel last_scored_at='1970-01-01' so the nightly refresh
-- re-scores them, BUT rows whose (persona_id, entity_id) appear in
-- persona_match_manual_overrides are stamped 'manual' so the manual
-- preservation contract holds across the migration boundary. INSERT
-- OR IGNORE preserves any rows already present (e.g. operator-pinned
-- entries created after the migration ran on dev).
INSERT OR IGNORE INTO persona_entity_matches (
  persona_id, entity_id, score, match_evidence_json, source,
  last_scored_at, model_version, created_at
)
SELECT
  pm.persona_id,
  elm.entity_id,
  COALESCE(pm.fit_score, 0) / 100.0,
  json_object('backfill_from','persona_matches','legacy_kind',pm.entity_kind,'legacy_components',pm.components_json,'legacy_fit_score',pm.fit_score,'manual_preserved', CASE WHEN mo.persona_id IS NOT NULL THEN 1 ELSE 0 END),
  CASE WHEN mo.persona_id IS NOT NULL THEN 'manual' ELSE 'auto' END,
  CASE WHEN mo.persona_id IS NOT NULL THEN datetime('now') ELSE '1970-01-01T00:00:00Z' END,
  CASE WHEN mo.persona_id IS NOT NULL THEN 'manual-legacy' ELSE 'v0-backfill' END,
  datetime('now')
FROM persona_matches pm
JOIN entity_legacy_map elm
  ON elm.legacy_table = CASE pm.entity_kind WHEN 'account' THEN 'accounts' WHEN 'buyer' THEN 'buyers' ELSE pm.entity_kind END
 AND elm.legacy_id = pm.entity_id
JOIN u_entities ue ON ue.id = elm.entity_id
LEFT JOIN persona_match_manual_overrides mo
  ON mo.persona_id = pm.persona_id AND mo.entity_id = elm.entity_id
WHERE ue.kind = 'person' AND ue.status = 'active';

-- Contract compatibility VIEW: consumers expecting the original
-- persona_matches column shape (persona_id, entity_kind, entity_id,
-- fit_score) can read this view, which surfaces the new
-- persona_entity_matches rows under that shape with entity_kind
-- inferred from u_entities.kind and fit_score back-scaled to 0..100.
-- Use this for backwards compatibility ONLY; new code should read
-- persona_entity_matches directly to get the component breakdown +
-- rationale + source.
DROP VIEW IF EXISTS persona_matches_v2;
CREATE VIEW persona_matches_v2 AS
SELECT
  pem.persona_id,
  ue.kind                       AS entity_kind,
  pem.entity_id,
  ROUND(pem.score * 100.0, 2)   AS fit_score,
  pem.source,
  pem.match_evidence_json       AS components_json,
  pem.last_scored_at            AS computed_at,
  pem.model_version
FROM persona_entity_matches pem
LEFT JOIN u_entities ue ON ue.id = pem.entity_id;
