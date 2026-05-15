-- Task 22: spreadsheet & PDF import.
-- One row per uploaded file. Lifecycle:
--   uploaded -> parsing -> mapped -> importing -> done | error

CREATE TABLE IF NOT EXISTS file_imports (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  mime TEXT,
  size INTEGER,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  entity TEXT,                  -- 'firms' | 'leads' (auto-detected, user-overridable)
  row_count INTEGER DEFAULT 0,
  rows_imported INTEGER DEFAULT 0,
  firms_created INTEGER DEFAULT 0,
  firms_updated INTEGER DEFAULT 0,
  leads_created INTEGER DEFAULT 0,
  leads_updated INTEGER DEFAULT 0,
  portfolio_created INTEGER DEFAULT 0,
  queued_jobs INTEGER DEFAULT 0,
  urls_found INTEGER DEFAULT 0,
  scrape_urls INTEGER DEFAULT 1,    -- 1 = enqueue scrape jobs for extracted URLs
  error TEXT,
  column_map_json TEXT,             -- {<header>: <field|"__skip__">}
  created_by TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_file_imports_status ON file_imports(status);
CREATE INDEX IF NOT EXISTS idx_file_imports_created_at ON file_imports(created_at);
