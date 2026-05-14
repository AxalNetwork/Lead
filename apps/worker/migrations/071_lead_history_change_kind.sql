-- Task 7 follow-up: a `change_kind` column on lead_history so semantically
-- meaningful events (e.g. GDPR erasure) can be queried directly without
-- relying on the per-field `source` value.
ALTER TABLE lead_history ADD COLUMN change_kind TEXT;
CREATE INDEX IF NOT EXISTS idx_lead_history_change_kind ON lead_history(change_kind);
