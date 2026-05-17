-- Task #3: csv_imports table per spec contract.
--
-- Lives alongside the existing `file_imports` table (which backs the
-- multi-format upload modal) — this table is the CSV-only spec
-- contract surfaced at /api/uploads/csv*. Each row is operator-scoped
-- via `user_email` from the Cloudflare Access JWT.
CREATE TABLE IF NOT EXISTS csv_imports (
  id                     TEXT PRIMARY KEY,
  user_email             TEXT NOT NULL,
  filename               TEXT NOT NULL,
  size_bytes             INTEGER NOT NULL,
  r2_key                 TEXT NOT NULL,
  status                 TEXT NOT NULL DEFAULT 'queued',
    -- queued | processing | completed | failed | cancelled | needs_manual_mapping
  total_rows             INTEGER,
  processed_rows         INTEGER NOT NULL DEFAULT 0,
  created_entities       INTEGER NOT NULL DEFAULT 0,
  updated_entities       INTEGER NOT NULL DEFAULT 0,
  detected_columns_json  TEXT,
  error_log_json         TEXT,
  content_hash           TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL,
  completed_at           TEXT,
  last_imported_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_csv_imports_user_created
  ON csv_imports (user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_csv_imports_status
  ON csv_imports (status);
CREATE INDEX IF NOT EXISTS idx_csv_imports_content_hash
  ON csv_imports (content_hash);
