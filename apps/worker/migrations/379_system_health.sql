-- Task #5: System Health & Errors Dashboard.
--
-- Spec said migration 371 but slots 350-378 are all taken (Task #2
-- compute pool is 378). Lands at the next free slot; future
-- migrations should number from 380.
--
-- Three tables:
--   1. ops_incidents       — append-mostly incident records with auto
--                            open/close semantics + free-form
--                            resolution_notes (mutable from the UI).
--   2. external_api_probes — every probe write (nightly + on-demand);
--                            the page reads the latest per api_name.
--   3. health_snapshots    — 5-min/hourly rollups keyed by
--                            (bucket_start, metric_name). The page
--                            sparklines hydrate from here.

CREATE TABLE IF NOT EXISTS ops_incidents (
  id                TEXT PRIMARY KEY,
  opened_at         TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at         TEXT,
  severity          TEXT NOT NULL DEFAULT 'warn',  -- info|warn|critical
  kind              TEXT NOT NULL,                 -- queue_age|node_down|error_rate|d1_throttle|external_api|other
  signature         TEXT NOT NULL,                 -- stable dedupe key (e.g. "queue_age:aidatasignal-lead-jobs")
  summary           TEXT NOT NULL,
  resolution_notes  TEXT,
  context_json      TEXT,                          -- snapshot at open time
  acked_at          TEXT,
  acked_by          TEXT,
  delivery_status   TEXT,                          -- "email:ok,slack:ok" | "email:err:..." | null
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ops_incidents_open
  ON ops_incidents(closed_at, kind, signature);
-- Atomic dedupe guard: at most one OPEN incident per signature.
-- SQLite partial unique index — applies only to rows with closed_at IS NULL,
-- so historic (closed) incidents for the same signature remain queryable.
-- The alert evaluator's INSERT uses `OR IGNORE` so a concurrent second
-- evaluator tick that lost the race is a clean no-op instead of a
-- constraint error.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ops_incidents_open_signature
  ON ops_incidents(signature) WHERE closed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ops_incidents_signature
  ON ops_incidents(signature, opened_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_incidents_opened
  ON ops_incidents(opened_at DESC);

CREATE TABLE IF NOT EXISTS external_api_probes (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  api_name                 TEXT NOT NULL,
  probed_at                TEXT NOT NULL DEFAULT (datetime('now')),
  ok                       INTEGER NOT NULL,           -- 0/1
  latency_ms               INTEGER,
  status_code              INTEGER,
  rate_limit_remaining     INTEGER,
  error                    TEXT,
  configured               INTEGER NOT NULL DEFAULT 1  -- 0 when required secret missing
);

CREATE INDEX IF NOT EXISTS idx_external_api_probes_latest
  ON external_api_probes(api_name, probed_at DESC);

CREATE TABLE IF NOT EXISTS health_snapshots (
  bucket_start  TEXT NOT NULL,                  -- ISO8601 floor of bucket
  metric_name   TEXT NOT NULL,                  -- e.g. "queue.depth.aidatasignal-lead-jobs"
  value         REAL,                           -- numeric gauge
  payload_json  TEXT,                           -- optional structured payload
  PRIMARY KEY (bucket_start, metric_name)
);

CREATE INDEX IF NOT EXISTS idx_health_snapshots_metric
  ON health_snapshots(metric_name, bucket_start DESC);
