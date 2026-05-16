-- Task #4: unified tag store. Sectors, stages, geos, personas, roles,
-- tech, accelerator cohorts, user-applied tags — all live as
-- (taxonomy, slug) pairs with a weight + source. Replaces the JSON arrays
-- spread across firms.sectors_json / stages_json / geo_focus_json,
-- companies.industries_json, accounts.industries_json, leads.tags_json.

CREATE TABLE IF NOT EXISTS entity_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  taxonomy TEXT NOT NULL,                       -- sector | stage | geo | persona | role | tech | accelerator | tag
  slug TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  source TEXT,
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, taxonomy, slug)
);

CREATE INDEX IF NOT EXISTS idx_entity_tags_entity ON entity_tags(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_tags_lookup ON entity_tags(taxonomy, slug);
CREATE INDEX IF NOT EXISTS idx_entity_tags_taxonomy_entity ON entity_tags(taxonomy, entity_id);
