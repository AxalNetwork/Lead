-- Task #2: Link discovery system.
--
-- Three tables back the discovery layer:
--   * discovered_urls — every URL we have ever seen (canonical UNIQUE),
--                      annotated with discovery method, yield prediction
--                      and status (`new` | `queued` | `crawled` | `rejected`).
--   * link_graph     — directed edges (src_url_id → dst_url_id) for the
--                      d3-force visualization. Composite PK.
--   * crawl_frontier — work queue for the polite scheduler. Url-id PK
--                      so the same URL never queues twice; priority is
--                      cached on the row for cheap ORDER BY.

CREATE TABLE IF NOT EXISTS discovered_urls (
  id                    TEXT PRIMARY KEY,
  url                   TEXT NOT NULL,
  url_canonical         TEXT NOT NULL UNIQUE,
  host                  TEXT NOT NULL,
  discovered_from_url   TEXT,
  discovered_from_id    TEXT REFERENCES discovered_urls(id) ON DELETE SET NULL,
  discovery_method      TEXT NOT NULL,            -- outbound | sitemap | rss_atom | …
  depth                 INTEGER NOT NULL DEFAULT 0,
  link_text             TEXT,
  link_context          TEXT,
  likely_kind           TEXT,                     -- team_page | bio | rsschedule | pdf | …
  expected_yield_score  REAL NOT NULL DEFAULT 0,  -- 0..1
  status                TEXT NOT NULL DEFAULT 'new',  -- new | queued | crawled | rejected | promoted
  rejected_reason       TEXT,
  job_id                TEXT,
  entity_ids_found_json TEXT,
  first_seen            TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_crawled_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_du_status_yield ON discovered_urls(status, expected_yield_score DESC);
CREATE INDEX IF NOT EXISTS idx_du_host         ON discovered_urls(host);
CREATE INDEX IF NOT EXISTS idx_du_from         ON discovered_urls(discovered_from_id);
CREATE INDEX IF NOT EXISTS idx_du_method       ON discovered_urls(discovery_method);

CREATE TABLE IF NOT EXISTS link_graph (
  src_url_id TEXT NOT NULL REFERENCES discovered_urls(id) ON DELETE CASCADE,
  dst_url_id TEXT NOT NULL REFERENCES discovered_urls(id) ON DELETE CASCADE,
  link_kind  TEXT,                       -- outbound | citation | sameAs | sitemap | …
  weight     REAL NOT NULL DEFAULT 1.0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (src_url_id, dst_url_id)
);
CREATE INDEX IF NOT EXISTS idx_lg_dst ON link_graph(dst_url_id);

CREATE TABLE IF NOT EXISTS crawl_frontier (
  url_id          TEXT PRIMARY KEY REFERENCES discovered_urls(id) ON DELETE CASCADE,
  priority        REAL NOT NULL DEFAULT 0,
  scheduled_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error      TEXT,
  run_id          TEXT REFERENCES discovery_runs(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_cf_priority ON crawl_frontier(priority DESC, scheduled_at ASC);
CREATE INDEX IF NOT EXISTS idx_cf_next     ON crawl_frontier(next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_cf_run      ON crawl_frontier(run_id);

-- Per-seed run summary so the dashboard can show progress without a slow scan.
CREATE TABLE IF NOT EXISTS discovery_runs (
  id              TEXT PRIMARY KEY,
  seed_url        TEXT NOT NULL,
  seed_host       TEXT,
  depth_max       INTEGER NOT NULL DEFAULT 3,
  max_per_host    INTEGER NOT NULL DEFAULT 200,
  methods_json    TEXT,
  status          TEXT NOT NULL DEFAULT 'running', -- running | completed | failed
  discovered      INTEGER NOT NULL DEFAULT 0,
  queued          INTEGER NOT NULL DEFAULT 0,
  crawled         INTEGER NOT NULL DEFAULT 0,
  entities_found  INTEGER NOT NULL DEFAULT 0,
  started_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at     TEXT,
  error           TEXT
);
CREATE INDEX IF NOT EXISTS idx_dr_started ON discovery_runs(started_at DESC);

-- Persistent run-wide host counters so `max_per_host` is enforced across
-- the recursive discovery + frontier-crawl fan-out, not just within a
-- single Worker invocation. PK keyed on (run_id, host) so the upsert is
-- a single round-trip.
CREATE TABLE IF NOT EXISTS discovery_run_hosts (
  run_id TEXT NOT NULL REFERENCES discovery_runs(id) ON DELETE CASCADE,
  host   TEXT NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, host)
);
