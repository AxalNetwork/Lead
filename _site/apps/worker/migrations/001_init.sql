CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  org TEXT,
  title TEXT,
  category TEXT,
  source_domain TEXT,
  source_url TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  verified INTEGER NOT NULL DEFAULT 0,
  flagged INTEGER NOT NULL DEFAULT 0,
  approved_at TEXT,
  approved_by TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);
CREATE INDEX IF NOT EXISTS idx_leads_source_domain ON leads(source_domain);
CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL UNIQUE,
  kind TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_scraped_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT,
  source TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  config_json TEXT,
  result_json TEXT,
  error TEXT,
  leads_found INTEGER DEFAULT 0,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_started_at ON jobs(started_at);

CREATE TABLE IF NOT EXISTS exports (
  id TEXT PRIMARY KEY,
  format TEXT NOT NULL,
  filter_json TEXT,
  row_count INTEGER DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_created_at ON exports(created_at);
