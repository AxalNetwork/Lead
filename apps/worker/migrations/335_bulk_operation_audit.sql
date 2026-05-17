-- Task #2 (bulk edit): one row per (operation, entity) affected by a
-- bulk endpoint in apps/worker/src/routes/bulk.ts. `before_json` is the
-- minimal snapshot needed to replay the inverse via /api/bulk/undo,
-- `after_json` is the post-mutation snapshot for observability. An
-- `Idempotency-Key` header collapses repeat POSTs to the same logical
-- request: `idempotency_keys` returns the original operation_id.

CREATE TABLE IF NOT EXISTS bulk_operation_audit (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id      TEXT    NOT NULL,
  action            TEXT    NOT NULL,           -- assign_role | add_tag | enrich | merge | delete | export
  entity_id         TEXT    NOT NULL,
  before_json       TEXT,                       -- minimal pre-mutation snapshot for undo
  after_json        TEXT,                       -- post-mutation snapshot
  performed_by_email TEXT,
  performed_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  undone_at         TEXT,
  undo_conflict     INTEGER NOT NULL DEFAULT 0  -- set by /undo when the row was further mutated
);

CREATE INDEX IF NOT EXISTS idx_bulk_audit_operation
  ON bulk_operation_audit(operation_id);
CREATE INDEX IF NOT EXISTS idx_bulk_audit_owner_time
  ON bulk_operation_audit(performed_by_email, performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_bulk_audit_entity
  ON bulk_operation_audit(entity_id);

-- Idempotency cache: `(email, key)` → original operation_id. A repeat
-- POST with the same Idempotency-Key returns the same operation_id and
-- never re-applies the mutation. Rows older than 24h are reaped by the
-- nightly housekeeping.
CREATE TABLE IF NOT EXISTS bulk_idempotency_keys (
  performed_by_email TEXT NOT NULL,
  idempotency_key    TEXT NOT NULL,
  operation_id       TEXT NOT NULL,
  action             TEXT NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (performed_by_email, idempotency_key)
);
