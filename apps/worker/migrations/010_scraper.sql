-- Task 1: Scraper engine columns on jobs
ALTER TABLE jobs ADD COLUMN kind TEXT;
ALTER TABLE jobs ADD COLUMN target TEXT;
ALTER TABLE jobs ADD COLUMN cancelled_at TEXT;
ALTER TABLE jobs ADD COLUMN cost_ms INTEGER DEFAULT 0;
ALTER TABLE jobs ADD COLUMN pages_fetched INTEGER DEFAULT 0;
ALTER TABLE jobs ADD COLUMN pages_blocked INTEGER DEFAULT 0;
ALTER TABLE jobs ADD COLUMN captcha_hits INTEGER DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_jobs_kind ON jobs(kind);
CREATE INDEX IF NOT EXISTS idx_jobs_target ON jobs(target);
