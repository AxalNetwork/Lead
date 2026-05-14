-- Task 2: per-field audit log for leads.
CREATE TABLE IF NOT EXISTS lead_history (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  source TEXT,
  evidence_url TEXT,
  changed_by TEXT,
  changed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lead_history_lead_id ON lead_history(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_history_field ON lead_history(field);
CREATE INDEX IF NOT EXISTS idx_lead_history_changed_at ON lead_history(changed_at);
