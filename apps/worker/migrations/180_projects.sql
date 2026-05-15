-- Task #47: Projects — multi-audience matching workspace.
--
-- A "project" is something the user is building (company, product,
-- initiative, fund, event, partnership) that needs to find customers,
-- investors, partners, hires, and design partners. Each project has
-- five audience tabs; per-audience matches are persisted in
-- `project_matches` and refreshed by MatchProjectWorkflow.

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,                                -- uuid v4
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',              -- 'active' | 'archived'
  kind TEXT,                                          -- 'company' | 'product' | 'fund' | 'event' | 'partnership' | 'initiative'
  one_liner TEXT,
  description TEXT,                                   -- markdown OK
  problems_solved TEXT,
  unique_value TEXT,
  stage TEXT,                                         -- 'idea' | 'mvp' | 'launched' | 'scaling'
  funding_status TEXT,                                -- 'pre_seed' | 'seed' | 'series_a' | ...
  funding_target REAL,                                -- USD; investor overlay uses this/10 as ideal check
  target_industries_json TEXT,                        -- ["fintech","saas"]
  target_geos_json TEXT,                              -- ["us","emea"]
  target_customer_size_bands_json TEXT,               -- ["51-200","201-500"]
  audiences_json TEXT,                                -- {"customer":true,"investor":true,...}
  customer_persona_ids_json TEXT,                     -- ["<persona_uuid>", ...]
  investor_persona_ids_json TEXT,
  partner_persona_ids_json TEXT,
  hire_persona_ids_json TEXT,
  design_partner_persona_ids_json TEXT,
  -- Embedding bookkeeping (re-embedded on every PATCH that changes text)
  embedding_dim INTEGER,
  embedded_at TEXT,
  embedding_text TEXT,
  -- Match counters maintained by the workflow
  match_count_customer INTEGER NOT NULL DEFAULT 0,
  match_count_investor INTEGER NOT NULL DEFAULT 0,
  match_count_partner INTEGER NOT NULL DEFAULT 0,
  match_count_hire INTEGER NOT NULL DEFAULT 0,
  match_count_design_partner INTEGER NOT NULL DEFAULT 0,
  matched_at TEXT,
  -- Materials (R2 keys + AI-extracted suggestions)
  materials_json TEXT,                                -- [{key, filename, mime, size, uploaded_at}]
  ai_suggestions_json TEXT,                           -- last "suggest from deck" output
  -- Bookkeeping
  last_modified TEXT NOT NULL DEFAULT (datetime('now')),
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
CREATE INDEX IF NOT EXISTS idx_projects_last_modified ON projects(last_modified DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(lower(name)) WHERE deleted_at IS NULL;

-- One row per (project, audience, entity). Upserted by the workflow.
CREATE TABLE IF NOT EXISTS project_matches (
  project_id TEXT NOT NULL,
  audience TEXT NOT NULL,                             -- 'customer'|'investor'|'partner'|'hire'|'design_partner'
  entity_kind TEXT NOT NULL,                          -- 'account'|'buyer'|'firm'|'company'|'lead'
  entity_id TEXT NOT NULL,
  rank INTEGER NOT NULL DEFAULT 0,                    -- 1..N within (project, audience)
  fit_score REAL NOT NULL DEFAULT 0,                  -- 0..100 final
  persona_score REAL NOT NULL DEFAULT 0,              -- 0..100
  semantic_score REAL NOT NULL DEFAULT 0,             -- 0..100 (cosine*100)
  overlay_score REAL NOT NULL DEFAULT 0,              -- 0..100 audience overlay
  components_json TEXT,                               -- per-overlay sub-components
  pitch_angle TEXT,                                   -- 2-sentence AI angle (top-50 only)
  pitch_angle_at TEXT,
  intro_path_json TEXT,                               -- shortest path through relationships graph
  status TEXT NOT NULL DEFAULT 'new',                 -- 'new'|'shortlisted'|'contacted'|'replied'|'qualified'|'won'|'lost'|'snoozed'
  notes TEXT,
  project_modified_at TEXT,                           -- snapshot for cache key
  entity_modified_at TEXT,
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, audience, entity_kind, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_project_matches_audience_rank ON project_matches(project_id, audience, rank ASC);
CREATE INDEX IF NOT EXISTS idx_project_matches_audience_score ON project_matches(project_id, audience, fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_project_matches_status ON project_matches(project_id, audience, status);
CREATE INDEX IF NOT EXISTS idx_project_matches_entity ON project_matches(entity_kind, entity_id);

-- Per-project field/status change log. Mirrors persona_history shape.
CREATE TABLE IF NOT EXISTS project_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  audience TEXT,                                      -- nullable for project-level changes
  entity_kind TEXT,
  entity_id TEXT,
  field TEXT NOT NULL,                                -- 'created'|'archived'|'restored'|'status'|<column>
  old_value TEXT,
  new_value TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_history_project ON project_history(project_id, changed_at DESC);
