-- Task #45: buyer-signal crawlers + raw-HTML archive.
--
-- Adds:
--   * signals.r2_key            R2 object key for the archived raw fetch
--                               (e.g. crawls/greenhouse/2026-05-15/<sha>.html)
--   * signals.evidence_snippet  short verbatim quote (<=512 chars) used by
--                               the dashboard "why" tooltip — avoids a
--                               second R2 fetch on every signal render.
--   * crawler_runs              one row per source-pass, used by
--                               /dashboard/crawlers/ to surface health.

ALTER TABLE signals ADD COLUMN r2_key TEXT;
ALTER TABLE signals ADD COLUMN evidence_snippet TEXT;

CREATE TABLE IF NOT EXISTS crawler_runs (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                 -- module slug (greenhouse|lever|...)
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running', -- running|ok|partial|error|disabled
  events_emitted INTEGER NOT NULL DEFAULT 0,
  signals_inserted INTEGER NOT NULL DEFAULT 0,
  signals_skipped INTEGER NOT NULL DEFAULT 0,
  accounts_created INTEGER NOT NULL DEFAULT 0,
  accounts_resolved INTEGER NOT NULL DEFAULT 0,
  fetch_count INTEGER NOT NULL DEFAULT 0,
  bytes_fetched INTEGER NOT NULL DEFAULT 0,
  cursor TEXT,                          -- opaque per-source cursor written back
  error TEXT,
  meta_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_crawler_runs_source_started ON crawler_runs(source, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_crawler_runs_status ON crawler_runs(status);

-- App-layer dedupe key (per source / per evidence url / per occurrence
-- timestamp). Prevents the same Greenhouse job posting from creating two
-- signals when re-crawled. We allow NULLs so manual signals (no source)
-- still slip through.
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedupe
  ON signals(account_id, kind, source, evidence_url, occurred_at)
  WHERE source IS NOT NULL AND evidence_url IS NOT NULL;
