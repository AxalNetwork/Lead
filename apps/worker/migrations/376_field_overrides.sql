-- Task #3: Editable Profiles + Manual Overrides with Audit.
--
-- Spec said slot 369 but slots 350-375 are taken (per the Task
-- #13/#14/#18/#2/#3/#4/#5/#6 contract-update precedent in replit.md;
-- 375 is the Task #9 garbage detector). Landing at the next free slot
-- (376) and recording the deviation in replit.md.
--
-- Three changes:
--   1) field_overrides — the typed override layer. Read path overlays
--      override values over `facts.is_current=1` rows for the same
--      (entity_id, predicate) when locked=1 and (unlock_after IS NULL
--      OR unlock_after > now).
--   2) entity_audit_log — append-only audit trail for every override /
--      unlock / soft-delete / restore / merge / create action. Never
--      UPDATE or DELETE. Restore / unlock are NEW rows, not edits.
--   3) facts.superseded_by_override — stamped to 1 by insertFact when
--      a locked override exists for the same (entity, predicate). The
--      AI/scrape attempt is preserved for the diff strip but never wins
--      the read race.

CREATE TABLE IF NOT EXISTS field_overrides (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  predicate TEXT NOT NULL,
  value_text TEXT,
  value_numeric REAL,
  value_json TEXT,                              -- stringified JSON
  override_reason TEXT,
  overridden_by_email TEXT NOT NULL,
  overridden_at TEXT NOT NULL DEFAULT (datetime('now')),
  locked INTEGER NOT NULL DEFAULT 1,            -- 1 = wins read race
  unlock_after TEXT,                            -- ISO ts; auto-unlocked by 15 3 cron tick
  bulk_operation_id TEXT                        -- shared across one bulk POST
);

CREATE INDEX IF NOT EXISTS idx_field_overrides_entity_pred
  ON field_overrides(entity_id, predicate, overridden_at DESC);
CREATE INDEX IF NOT EXISTS idx_field_overrides_bulk
  ON field_overrides(bulk_operation_id) WHERE bulk_operation_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_field_overrides_unlock_after
  ON field_overrides(unlock_after) WHERE unlock_after IS NOT NULL AND locked = 1;

CREATE TABLE IF NOT EXISTS entity_audit_log (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,                         -- field_override | field_unlock | bulk_override | bulk_revert | soft_delete | restore | merge | create
  actor_email TEXT NOT NULL,
  payload_json TEXT,                            -- stringified JSON: predicate, old/new value, bulk_operation_id, etc.
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entity_audit_log_entity
  ON entity_audit_log(entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_audit_log_action
  ON entity_audit_log(action);

-- Stamped by insertFact when a locked override pre-empts the write.
-- The fact row is still inserted (preserves the AI attempt for the
-- diff strip) but never wins the read race; getEffectiveFacts filters
-- it out at read time.
ALTER TABLE facts ADD COLUMN superseded_by_override INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_facts_superseded_by_override
  ON facts(entity_id, predicate) WHERE superseded_by_override = 1;
