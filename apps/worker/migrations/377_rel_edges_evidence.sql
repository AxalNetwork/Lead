-- Task #4 (Relationship Inference Worker): additive columns on rel_edges so
-- the new persist layer can bump an evidence counter on re-extraction
-- (instead of minting duplicate edges) and surface "last seen" in the UI.
--
-- Migration numbering: spec did not pin a slot. Slots 350-376 are all
-- taken (per replit.md Task #13/#14/#18/#2/#3/#4/#5/#6/#11/#12/#3
-- contract-update notes). This lands at 377 — the next free slot.
-- Future migrations should number from 378.
--
-- Per the Task #3 edge-quality contract, this migration does NOT
-- touch quality_score / quality_signals_json — those remain owned by
-- the Task #3 nightly sweep. New columns are strictly additive and
-- compatible with the existing uq_rel_edges_quad unique index.

ALTER TABLE rel_edges ADD COLUMN evidence_count INTEGER NOT NULL DEFAULT 1;
ALTER TABLE rel_edges ADD COLUMN last_evidence_at TEXT;

-- Incremental inference staging queue. The existing JobKind enum has no
-- `relationship_infer` value, so per the spec's "fall back to scheduling
-- on the nightly tick" rule, entities flagged by `createEntity` /
-- `insertFact` land here and the consolidated nightly slot drains the
-- queue with the per-entity orchestrator pass. KV-debounced upstream so
-- a burst of writes coalesces into one staging row.
CREATE TABLE IF NOT EXISTS relationship_infer_queue (
  entity_id   TEXT PRIMARY KEY,
  queued_at   TEXT NOT NULL DEFAULT (datetime('now')),
  reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_rel_infer_queue_queued_at
  ON relationship_infer_queue(queued_at);
