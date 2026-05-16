-- Task #4: unified audit trail. Consolidates lead_history / firm_history /
-- account_history into one table covering every kind of mutation on an
-- entity (create/update/merge/split/restore/soft_delete/dnc), with
-- predicate-level old/new values.

CREATE TABLE IF NOT EXISTS entity_history (
  id TEXT PRIMARY KEY,                          -- uuid v4
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,                         -- create | update | merge | split | restore | soft_delete | dnc | role_added | role_removed
  predicate TEXT,                               -- nullable (e.g. for 'merge' the whole row changed)
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  evidence_url TEXT,
  changed_by TEXT,
  related_entity_id TEXT,                       -- for merge: the secondary that was absorbed
  changed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entity_history_entity ON entity_history(entity_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_entity_history_action ON entity_history(action);
CREATE INDEX IF NOT EXISTS idx_entity_history_related ON entity_history(related_entity_id) WHERE related_entity_id IS NOT NULL;
