-- Task #2: News ingestion, citations & fact verification.
--
-- Four tables + one column on `facts`:
--   * news_items              — one row per fetched article (deduped by url).
--   * news_entity_mentions    — many-to-many between news_items and u_entities.
--   * fact_citations          — links a fact to a news_item with quote/contradicts flag.
--   * source_reputability     — per-host authority score 0..1 with tier + country.
--   * facts.verified_score    — derived score (recomputed by news/score.ts).

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,                           -- uuid v4
  url TEXT NOT NULL UNIQUE,
  url_canonical TEXT,
  host TEXT NOT NULL,
  title TEXT,
  headline TEXT,
  byline TEXT,
  published_at TEXT,
  source_name TEXT,
  source_reputability REAL NOT NULL DEFAULT 0.4, -- snapshot of source_reputability.score at fetch
  language TEXT,
  summary TEXT,                                  -- 1-paragraph LLM summary (cached)
  body_excerpt TEXT,                             -- ~2KB sanitized excerpt
  body_r2_key TEXT,                              -- R2 key into RAW_HTML bucket (full body)
  archive_url TEXT,                              -- web.archive.org URL after save
  archive_date TEXT,
  topics_json TEXT,                              -- JSON array of detected topics
  sentiment REAL,                                -- -1..1 article-level sentiment
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_news_items_host ON news_items(host);
CREATE INDEX IF NOT EXISTS idx_news_items_published ON news_items(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_news_items_fetched ON news_items(fetched_at DESC);

CREATE TABLE IF NOT EXISTS news_entity_mentions (
  id TEXT PRIMARY KEY,
  news_item_id TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  mention_count INTEGER NOT NULL DEFAULT 1,
  context_quote TEXT,
  is_subject INTEGER NOT NULL DEFAULT 0,         -- 1 = entity is article subject
  sentiment_about_entity REAL,                   -- -1..1
  confidence REAL NOT NULL DEFAULT 0.75,         -- entity-resolution confidence
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(news_item_id, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_nem_news ON news_entity_mentions(news_item_id);
CREATE INDEX IF NOT EXISTS idx_nem_entity ON news_entity_mentions(entity_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_nem_subject ON news_entity_mentions(entity_id, is_subject);

CREATE TABLE IF NOT EXISTS fact_citations (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  news_item_id TEXT NOT NULL,
  quote TEXT,
  contradicts INTEGER NOT NULL DEFAULT 0,        -- 1 = citation disagrees with the fact's value
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(fact_id, news_item_id)
);

CREATE INDEX IF NOT EXISTS idx_fc_fact ON fact_citations(fact_id);
CREATE INDEX IF NOT EXISTS idx_fc_news ON fact_citations(news_item_id);
CREATE INDEX IF NOT EXISTS idx_fc_contradicts ON fact_citations(contradicts) WHERE contradicts = 1;

CREATE TABLE IF NOT EXISTS source_reputability (
  host TEXT PRIMARY KEY,
  score REAL NOT NULL DEFAULT 0.4,               -- 0..1
  tier TEXT,                                     -- 'primary' | 'major' | 'mid' | 'blog' | 'tabloid' | 'ugc' | 'regulator' | 'wiki'
  country TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sr_score ON source_reputability(score DESC);
CREATE INDEX IF NOT EXISTS idx_sr_tier ON source_reputability(tier);

-- facts.verified_score (0..1). Recomputed after every citation insert.
-- Added via INSERT-OR-IGNORE pattern: ALTER TABLE in D1 is single-statement,
-- so we wrap in a no-op CREATE TABLE meta to keep idempotency.
-- SQLite doesn't support IF NOT EXISTS on ADD COLUMN; the migration runner
-- swallows duplicate-column errors.
ALTER TABLE facts ADD COLUMN verified_score REAL NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_facts_verified_score ON facts(verified_score DESC);

-- Dispute resolution audit log. Recorded when a user marks a fact as canonical
-- against contradicting citations. Reuses entity history pattern.
CREATE TABLE IF NOT EXISTS fact_dispute_resolutions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL,
  competing_fact_id TEXT,
  decision TEXT NOT NULL,                        -- 'canonical' | 'rejected' | 'merged'
  notes TEXT,
  resolved_by TEXT,
  resolved_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fdr_fact ON fact_dispute_resolutions(fact_id);
