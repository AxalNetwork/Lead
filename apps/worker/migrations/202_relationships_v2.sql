-- Task #4: typed edges between entities. Supersedes the Task 19 graph.
-- Every edge carries its strength, validity window, and evidence
-- (free-text URL + JSON array of backing fact ids).

CREATE TABLE IF NOT EXISTS rel_edges (
  id TEXT PRIMARY KEY,                          -- uuid v4
  src_entity_id TEXT NOT NULL,
  dst_entity_id TEXT NOT NULL,
  kind TEXT NOT NULL,                           -- enum (see app layer)
  strength REAL NOT NULL DEFAULT 1.0,           -- 0..1
  valid_from TEXT,
  valid_to TEXT,
  evidence_url TEXT,
  backing_fact_ids_json TEXT,                   -- JSON array of facts.id
  source TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Uniqueness on (src, dst, kind, valid_from): inline UNIQUE forbids
-- COALESCE expressions in SQLite, so we use a unique INDEX with an
-- IFNULL projection of valid_from so NULL collapses to ''.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rel_edges_quad
  ON rel_edges(src_entity_id, dst_entity_id, kind, IFNULL(valid_from, ''));

CREATE INDEX IF NOT EXISTS idx_rel_edges_src ON rel_edges(src_entity_id, kind);
CREATE INDEX IF NOT EXISTS idx_rel_edges_dst ON rel_edges(dst_entity_id, kind);
CREATE INDEX IF NOT EXISTS idx_rel_edges_kind ON rel_edges(kind);
