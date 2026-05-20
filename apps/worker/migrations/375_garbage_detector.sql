-- Task #9: Garbage Entity Detector & Cleanup.
--
-- Migration slot deviation: spec said 368, but 350-374 are all taken
-- (Task #13/#14/#18/#2/#3/#4/#5/#6/#8 contract-update precedent in
-- replit.md). Lands at 375 — next free slot above the Task #8 ML
-- Quality Ops migration (374). Future migrations should number from 376.
--
-- This migration ONLY adds schema. The one-off cleanup pass that
-- soft-deletes existing garbage runs as a JS function
-- (`runCleanupSweep({ all: true })` in `apps/worker/src/entities/garbage.ts`)
-- triggered from the admin endpoint POST /api/ops/garbage-review/cleanup-now
-- and inline inside the nightly cron sweep on first invocation. We
-- prefer this over a SQL-only one-off because the detector's
-- structural rule (zero facts + zero rels + zero channels + crawler-
-- created >24h ago) requires JOINs across four tables and is far
-- easier to verify and bound in TypeScript than in a migration file.

-- 1. Soft-delete reason column on u_entities. The status enum already
--    includes 'soft_deleted' (migration 200) so this is the only new
--    column needed for the soft-delete contract.
ALTER TABLE u_entities ADD COLUMN deleted_reason TEXT;

-- 2. Append-only audit log for every detector verdict + lifecycle
--    transition (detected | soft_deleted | restored | purged). One row
--    per event; never updated in place.
CREATE TABLE IF NOT EXISTS data_quality_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id TEXT NOT NULL,
  issue TEXT NOT NULL,          -- 'garbage_detected' | 'soft_deleted' | 'restored' | 'purged' | 'pre_insert_rejected'
  reasons_json TEXT,            -- JSON array of reason codes from isGarbage()
  source TEXT,                  -- 'oneoff_cleanup' | 'cron_sweep' | 'pre_insert_guard' | 'operator'
  actor_email TEXT,             -- when source='operator'
  detected_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dql_entity ON data_quality_log(entity_id);
CREATE INDEX IF NOT EXISTS idx_dql_detected ON data_quality_log(detected_at);
CREATE INDEX IF NOT EXISTS idx_dql_issue ON data_quality_log(issue);
