-- Task #9: External Worker Pool (GPU & 3rd-party servers).
--
-- Spec said the schema lands at migration 370, but slots 350-377 are
-- all taken (per the Task #13/#14/#18/#2/#3/#4/#5/#6 contract-update
-- precedent in replit.md; in particular 377 = Task #4 rel_edges
-- evidence). This is migration 378; future migrations should number
-- from 379.
--
-- Per-node HMAC secret lives in KV ONLY at `auth_secret_kv_key`; D1
-- stores just the KV path. Registration response is the one and only
-- time the secret crosses the wire (environment-secrets posture).

CREATE TABLE IF NOT EXISTS compute_nodes (
  id                   TEXT PRIMARY KEY,                  -- node_<short>
  name                 TEXT NOT NULL,
  provider             TEXT NOT NULL,                     -- runpod|hetzner|aws|modal|fly|self|other
  kind                 TEXT NOT NULL,                     -- cpu|gpu|browser
  endpoint_url         TEXT,                              -- inbound (rare; we poll out)
  auth_secret_kv_key   TEXT NOT NULL UNIQUE,              -- KV path to HMAC secret
  supported_job_types  TEXT NOT NULL DEFAULT '[]',        -- JSON array
  capabilities_json    TEXT NOT NULL DEFAULT '{}',        -- per-deployment routing override
  max_concurrent_jobs  INTEGER NOT NULL DEFAULT 1,
  current_active_jobs  INTEGER NOT NULL DEFAULT 0,
  cost_per_hour_usd        REAL NOT NULL DEFAULT 0,
  cost_per_1k_tokens_usd   REAL NOT NULL DEFAULT 0,
  enabled              INTEGER NOT NULL DEFAULT 1,
  drain                INTEGER NOT NULL DEFAULT 0,        -- soft drain: no new dispatches
  registered_by        TEXT,
  registered_at        TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at    TEXT,
  last_error           TEXT,
  notes                TEXT
);

CREATE INDEX IF NOT EXISTS idx_compute_nodes_enabled
  ON compute_nodes(enabled, drain, last_heartbeat_at);

CREATE TABLE IF NOT EXISTS compute_job_assignments (
  id              TEXT PRIMARY KEY,                       -- asg_<short>
  node_id         TEXT NOT NULL,
  job_id          TEXT NOT NULL,                          -- caller's job id (free-form)
  job_type        TEXT NOT NULL,
  payload_bytes   INTEGER NOT NULL DEFAULT 0,
  payload_r2_key  TEXT,                                   -- non-null when payload>256KB
  output_r2_key   TEXT,                                   -- non-null when output>256KB
  status          TEXT NOT NULL DEFAULT 'dispatched',     -- dispatched|running|completed|failed|reassigned|timeout|unsupported
  deadline_at     TEXT NOT NULL,
  dispatched_at   TEXT NOT NULL DEFAULT (datetime('now')),
  started_at      TEXT,
  completed_at    TEXT,
  runtime_ms      INTEGER,
  tokens_used     INTEGER NOT NULL DEFAULT 0,
  cost_usd        REAL NOT NULL DEFAULT 0,
  error           TEXT,
  result_json     TEXT,                                   -- inline result snippet (<= 8KB)
  reassigned_from TEXT,                                   -- prior asg_id for chain visibility
  FOREIGN KEY (node_id) REFERENCES compute_nodes(id)
);

CREATE INDEX IF NOT EXISTS idx_cja_node_status
  ON compute_job_assignments(node_id, status, dispatched_at);
CREATE INDEX IF NOT EXISTS idx_cja_status_deadline
  ON compute_job_assignments(status, deadline_at);
CREATE INDEX IF NOT EXISTS idx_cja_job
  ON compute_job_assignments(job_id);
