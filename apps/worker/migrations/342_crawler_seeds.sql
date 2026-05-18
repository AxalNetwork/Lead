-- Task #3: Crawler seeds + smart frontier.
--
-- Two tables sit alongside the existing Task #2 discovery layer:
--
--   * crawler_seeds   — one row per starting point per profile type.
--                       Drives the hourly seed-sweep cron.
--   * smart_frontier  — next-URL candidates emitted by the frontier
--                       expander. Distinct from the existing
--                       `crawl_frontier` (which is a url_id-keyed work
--                       queue for the Task #2 discovery layer). The
--                       smart frontier carries profile-type tagging
--                       + discovery_reason + priority so operators can
--                       inspect the per-type funnel.
--
-- DESIGN NOTE — staging vs. direct write to crawl_frontier:
--   The Task #3 spec text says "candidates land in crawl_frontier".
--   Task #2 already owns that table name with a different schema
--   (url_id PK, no discovery_reason / priority / per-type tagging).
--   Rather than re-shape Task #2's queue, smart_frontier acts as a
--   typed, priority-ranked STAGING area. An hourly drainer
--   (services/frontier/drain.ts) pops top-priority rows and bridges
--   them into the Task #2 crawl_frontier work queue via
--   upsertDiscoveredUrl + enqueueFrontier. Operators inspect the
--   per-type funnel here; the crawler still pulls work from the
--   single Task #2 queue.
--
-- Unique (profile_type_id, seed_kind, value) lets the seed migration
-- re-run idempotently via INSERT OR REPLACE.

CREATE TABLE IF NOT EXISTS crawler_seeds (
  id                      TEXT PRIMARY KEY,
  profile_type_id         TEXT NOT NULL REFERENCES e_types(id) ON DELETE CASCADE,
  seed_kind               TEXT NOT NULL,                              -- url | search_query | directory_pattern
  value                   TEXT NOT NULL,
  refresh_interval_hours  INTEGER NOT NULL DEFAULT 168,               -- weekly default
  last_crawled_at         TEXT,
  success_count           INTEGER NOT NULL DEFAULT 0,
  entity_count            INTEGER NOT NULL DEFAULT 0,
  enabled                 INTEGER NOT NULL DEFAULT 1,                 -- 0|1
  notes                   TEXT,
  created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (profile_type_id, seed_kind, value)
);
CREATE INDEX IF NOT EXISTS idx_cs_sweep    ON crawler_seeds(profile_type_id, enabled, last_crawled_at);
CREATE INDEX IF NOT EXISTS idx_cs_stale    ON crawler_seeds(enabled, last_crawled_at);

CREATE TABLE IF NOT EXISTS smart_frontier (
  id                  TEXT PRIMARY KEY,
  url                 TEXT NOT NULL,
  url_canonical       TEXT NOT NULL,
  host                TEXT NOT NULL,
  profile_type_id     TEXT REFERENCES e_types(id) ON DELETE SET NULL,
  discovery_reason    TEXT NOT NULL,                                  -- linked_team_member | linked_portfolio_company | ...
  priority            REAL NOT NULL DEFAULT 0,
  source_url          TEXT,
  source_authority    REAL NOT NULL DEFAULT 0.4,
  novelty_score       REAL NOT NULL DEFAULT 1.0,
  status              TEXT NOT NULL DEFAULT 'queued',                 -- queued | enqueued | crawled | rejected
  discovered_at       TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  enqueued_at         TEXT,
  UNIQUE (profile_type_id, url_canonical)
);
CREATE INDEX IF NOT EXISTS idx_sf_drain    ON smart_frontier(status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_sf_by_type  ON smart_frontier(profile_type_id, status, priority DESC);
CREATE INDEX IF NOT EXISTS idx_sf_host     ON smart_frontier(host);
