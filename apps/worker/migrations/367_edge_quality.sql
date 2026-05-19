-- Task #3: Edge-Quality Scoring + Power-Node Detection.
--
-- Migration numbering: spec said 353, but slots 350-366 are all
-- taken (per replit.md Task #13/#14/#18/#2 contract-update notes).
-- This lands at 367 — the next free slot. Future migrations should
-- number from 368.
--
-- Adds three columns to rel_edges:
--   - quality_score        REAL  0..1, aggregated from 8 public signals
--   - quality_signals_json TEXT  per-signal breakdown for forensic review
--   - last_interaction_at  TEXT  ISO date of latest observed interaction
-- and creates entity_influence — one row per entity carrying global
-- PageRank, per-sector PageRank breakdown, broker score, and degree
-- counts. Recomputed nightly by the consolidated nightly slot.
--
-- All derived per-entity facts (entity.pagerank_score,
-- entity.broker_score) are mirrored via insertFact in the sweep
-- module per the Task #1 canonical write contract — this migration
-- does NOT write to the facts table directly.

ALTER TABLE rel_edges ADD COLUMN quality_score REAL;
ALTER TABLE rel_edges ADD COLUMN quality_signals_json TEXT;
ALTER TABLE rel_edges ADD COLUMN last_interaction_at TEXT;

-- Filterable by quality threshold (used by
-- /api/entities/:id/relationships?min_quality=…).
CREATE INDEX IF NOT EXISTS idx_rel_edges_quality
  ON rel_edges(src_entity_id, quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_rel_edges_quality_dst
  ON rel_edges(dst_entity_id, quality_score DESC);

CREATE TABLE IF NOT EXISTS entity_influence (
  entity_id            TEXT PRIMARY KEY,
  pagerank_score       REAL NOT NULL DEFAULT 0,    -- global PageRank, 0..1 (normalized)
  sector_pagerank_json TEXT,                       -- { "<sector>": <score>, ... }
  broker_score         REAL NOT NULL DEFAULT 0,    -- Burt's structural-holes constraint inverted (0..1)
  in_degree            INTEGER NOT NULL DEFAULT 0,
  out_degree           INTEGER NOT NULL DEFAULT 0,
  total_degree         INTEGER NOT NULL DEFAULT 0,
  is_power_node        INTEGER NOT NULL DEFAULT 0, -- 1 if entity is in the top-N for its primary sector
  primary_sector       TEXT,                       -- best-effort, copied from facts at compute time
  computed_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entity_influence_pr
  ON entity_influence(pagerank_score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_influence_power
  ON entity_influence(is_power_node, pagerank_score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_influence_sector
  ON entity_influence(primary_sector, pagerank_score DESC);
