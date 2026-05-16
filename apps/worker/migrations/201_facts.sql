-- Task #4: facts table. Every observed attribute about an entity lands
-- here with its source, confidence, and validity window. Multiple sources
-- can co-exist; `is_current=1` marks the chosen value per (entity,
-- predicate, source). `hash` dedupes exact re-observations.

CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,                          -- uuid v4
  entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,                      -- e.g. 'name' | 'title' | 'email' | 'check_size_max_usd' | 'sector'
  value_text TEXT,                              -- for text/string values
  value_number REAL,                            -- for numeric values
  value_json TEXT,                              -- for structured values
  value_entity_id TEXT,                         -- for entity-valued predicates (e.g. 'employer')
  source_kind TEXT NOT NULL,                    -- 'scrape' | 'import' | 'manual' | 'enrichment' | 'ai' | 'inferred'
  source TEXT,                                  -- provider/parser name (e.g. 'hunter.io', 'profile/linkedin')
  evidence_url TEXT,
  confidence REAL NOT NULL DEFAULT 1.0,         -- 0..1
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  valid_from TEXT,
  valid_to TEXT,
  supersedes_fact_id TEXT,                      -- previous fact this one replaces
  is_current INTEGER NOT NULL DEFAULT 1,
  hash TEXT NOT NULL,                           -- sha256(entity_id|predicate|value|source) for dedup
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(hash)
);

CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity_id);
CREATE INDEX IF NOT EXISTS idx_facts_entity_predicate_current
  ON facts(entity_id, predicate, is_current);
CREATE INDEX IF NOT EXISTS idx_facts_predicate_value_text
  ON facts(predicate, value_text) WHERE is_current = 1 AND value_text IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_predicate_value_number
  ON facts(predicate, value_number) WHERE is_current = 1 AND value_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_value_entity
  ON facts(value_entity_id) WHERE value_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_observed ON facts(observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_facts_source_kind ON facts(source_kind);
