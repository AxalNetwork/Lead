-- Task #5: Profile types registry (e_types). Single source of truth for
-- the ~80 profile types the page router, seed-discovery, and per-type
-- enrichment workflows consume. JSON columns hold the detection
-- signals, enrichment predicates, and seed sources for each type.

CREATE TABLE IF NOT EXISTS e_types (
  id                        TEXT PRIMARY KEY,
  label                     TEXT NOT NULL,
  category                  TEXT NOT NULL,
  entity_kind               TEXT NOT NULL,
  parent_type_id            TEXT REFERENCES e_types(id) ON DELETE SET NULL,
  detection_signals_json    TEXT NOT NULL DEFAULT '{}',
  enrichment_predicates_json TEXT NOT NULL DEFAULT '[]',
  seed_sources_json         TEXT NOT NULL DEFAULT '{}',
  icon                      TEXT,
  color                     TEXT,
  created_at                TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at                TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (entity_kind IN ('person','company')),
  CHECK (category IN ('capital','legal','financial','operator','advisory','talent','press','policy','technical','academic','company','service_firm','public_sector'))
);

CREATE INDEX IF NOT EXISTS idx_e_types_category_kind ON e_types(category, entity_kind);
CREATE INDEX IF NOT EXISTS idx_e_types_parent ON e_types(parent_type_id);
