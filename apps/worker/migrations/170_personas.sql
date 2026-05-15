-- Task #46: Persona profiler.
--
-- Three tables:
--   personas         reusable target-customer definitions
--   persona_matches  per-(persona, entity) cached fit_score + explanation
--   persona_history  field-level change log for personas
--
-- Match rows are upserted by RescorePersonaWorkflow and read by the
-- dashboard "Top matches" pane + /api/personas/:id/matches.

CREATE TABLE IF NOT EXISTS personas (
  id TEXT PRIMARY KEY,                          -- uuid v4
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'account',         -- 'account' | 'buyer'
  status TEXT NOT NULL DEFAULT 'active',        -- 'active' | 'archived'
  thesis TEXT,                                  -- free-form description
  -- Hard filters (gate; failure forces fit_score=0)
  hard_filters_json TEXT,                       -- {require_domain, statuses, country_iso2_in, ...}
  -- Sizing
  size_min INTEGER,                             -- min employees
  size_max INTEGER,
  size_bands_json TEXT,                         -- ["51-200","201-500"]
  -- Geo
  geos_json TEXT,                               -- ["us","ca","emea"]
  -- Industry
  industries_json TEXT,                         -- ["fintech","saas"]
  -- Tech
  techs_required_json TEXT,                     -- ["snowflake"]
  techs_preferred_json TEXT,                    -- ["dbt","airflow"]
  techs_excluded_json TEXT,                     -- ["redshift"]
  -- Signal preferences
  signal_kinds_json TEXT,                       -- preferred kinds; full-credit if matched
  -- Buyer preferences (for buyer-kind personas; also used to score accounts via their buyers)
  buyer_titles_json TEXT,
  buyer_seniority_json TEXT,                    -- ["c_suite","vp","director"]
  buyer_departments_json TEXT,                  -- ["engineering","data"]
  -- Scoring overrides
  weights_json TEXT,                            -- {size:0.1, geo:0.1, industry:0.2, ...}
  semantic_fit_threshold REAL,                  -- min cosine for semantic_fit credit
  recency_boost REAL,                           -- override (default 1.0; capped 1..1.2)
  -- Embedding
  embedding_dim INTEGER,
  embedded_at TEXT,
  embedding_text TEXT,                          -- materialized text used for the embedding
  -- LLM Analyze result
  persona_notes TEXT,
  notes_generated_at TEXT,
  -- Bookkeeping
  last_modified TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_personas_status ON personas(status);
CREATE INDEX IF NOT EXISTS idx_personas_kind ON personas(kind);
CREATE INDEX IF NOT EXISTS idx_personas_last_modified ON personas(last_modified DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_personas_name ON personas(lower(name)) WHERE deleted_at IS NULL;

-- One row per (persona, entity). entity_kind ∈ {'account','buyer'}.
CREATE TABLE IF NOT EXISTS persona_matches (
  persona_id TEXT NOT NULL,
  entity_kind TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  fit_score REAL NOT NULL DEFAULT 0,            -- 0..100
  hard_filter_pass INTEGER NOT NULL DEFAULT 0,
  components_json TEXT,                         -- per-component scores
  explanation TEXT,                             -- 2-sentence AI explanation (only when fit_score>=50)
  explanation_at TEXT,
  persona_modified_at TEXT,                     -- snapshot for cache key
  entity_modified_at TEXT,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (persona_id, entity_kind, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_persona_matches_persona_score ON persona_matches(persona_id, fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_persona_matches_entity ON persona_matches(entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS idx_persona_matches_high ON persona_matches(persona_id, fit_score DESC) WHERE fit_score >= 60;

-- Field-level change log. Mirrors account_history shape.
CREATE TABLE IF NOT EXISTS persona_history (
  id TEXT PRIMARY KEY,
  persona_id TEXT NOT NULL,
  field TEXT NOT NULL,                          -- 'created'|'archived'|'restored'|<column>
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_persona_history_persona ON persona_history(persona_id, changed_at DESC);

-- Buyer-side fit_score writeback: mirrors accounts.fit_score so the
-- buyers list page can sort/filter by max-active-persona fit without
-- re-aggregating persona_matches at read time. Maintained by
-- writeBackEntityFit during rescore.
ALTER TABLE buyers ADD COLUMN fit_score REAL NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_buyers_fit_score ON buyers(fit_score DESC);
