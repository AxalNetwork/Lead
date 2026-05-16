-- Task #3: Due diligence & risk/trust scoring.
--
-- Three tables drive the DD surface:
--
--   dd_findings           One row per finding (sanction hit, PEP hit,
--                         adverse media item, court case, enforcement,
--                         green flag, etc). Mostly append-only; superseded
--                         findings are flagged `status='resolved'` rather
--                         than deleted so the audit trail stays intact.
--
--   dd_watchlist_cache    Daily-refreshed cache of (provider, list_name)
--                         payloads. We don't store the full record body
--                         here — just the count + a content hash + the
--                         R2 key of the snapshot — so the refresh job
--                         is cheap and reproducible. R2 holds the full
--                         JSON under `dd-watchlists/<provider>/<date>.json`.
--
--   entity_risk_scores    One row per entity holding the latest risk +
--                         trust scores plus a digest of contributing
--                         findings. Recomputed by the scan workflow.
--
-- All three are keyed on `entities.id` (INTEGER) — the existing graph
-- entity table from migration 110.

CREATE TABLE IF NOT EXISTS dd_findings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id INTEGER NOT NULL,
  -- High-level finding category. Keep narrow so the UI can switch on it.
  --   sanction              hit on OFAC/EU/UN/UK HMT/OpenSanctions consolidated
  --   pep                   politically exposed person
  --   adverse_media         negative news mention (fraud/litigation/etc)
  --   court_case            US/UK court filing
  --   enforcement           SEC/FCA/FINRA enforcement action
  --   disqualified_director UK Companies House disqualified directors
  --   green_flag            positive signal (award, advisory board, etc)
  --   note                  reviewer-authored note
  finding_type TEXT NOT NULL,
  -- Sub-classifier; provider-specific. e.g. for `sanction`:
  --   ofac_sdn | eu_consolidated | un_consolidated | uk_hmt | opensanctions_consolidated
  finding_subtype TEXT,
  -- Provenance.
  source_provider TEXT NOT NULL,    -- e.g. "opensanctions", "sec_edgar", "gdelt", "newsapi"
  source_url TEXT,                   -- canonical URL of the original finding
  source_payload_r2_key TEXT,        -- R2 key of the raw payload snapshot
  -- Matching metadata.
  match_score REAL,                  -- 0..1 final composite match score
  match_method TEXT,                 -- "exact" | "phonetic" | "fuzzy" | "vector" | "ai_arbitrated"
  match_evidence_json TEXT,          -- {name_score, phonetic_score, ...}
  -- Human-readable summary, kept short so list views can render it inline.
  title TEXT NOT NULL,
  description TEXT,
  severity TEXT NOT NULL DEFAULT 'medium',  -- low | medium | high | critical
  -- Lifecycle. `open` is the default; reviewers move things to
  -- `confirmed`, `false_positive`, or `resolved`. Status drives whether
  -- the finding contributes to the risk score.
  status TEXT NOT NULL DEFAULT 'open',
  reviewed_by TEXT,                  -- email of reviewer
  reviewed_at TEXT,
  reviewer_notes TEXT,
  -- Temporal envelope.
  observed_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT,                   -- optional TTL for ephemeral signals
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_dd_findings_entity ON dd_findings(entity_id);
CREATE INDEX IF NOT EXISTS idx_dd_findings_type ON dd_findings(finding_type);
CREATE INDEX IF NOT EXISTS idx_dd_findings_status ON dd_findings(status);
CREATE INDEX IF NOT EXISTS idx_dd_findings_severity ON dd_findings(severity);
CREATE INDEX IF NOT EXISTS idx_dd_findings_provider ON dd_findings(source_provider);
CREATE INDEX IF NOT EXISTS idx_dd_findings_observed ON dd_findings(observed_at);
-- One finding per (entity, provider, source_url) to make scans idempotent.
-- COALESCE on source_url so two findings with NULL url still collide on
-- (entity, provider, title) via the lower-priority index below.
CREATE UNIQUE INDEX IF NOT EXISTS uq_dd_findings_dedupe
  ON dd_findings(entity_id, source_provider, COALESCE(source_url, ''), COALESCE(finding_subtype, ''));

CREATE TABLE IF NOT EXISTS dd_watchlist_cache (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,            -- "ofac" | "eu" | "un" | "uk_hmt" | "opensanctions" | ...
  list_name TEXT NOT NULL,           -- "consolidated" | "sdn" | "pep" | ...
  snapshot_date TEXT NOT NULL,       -- YYYY-MM-DD
  record_count INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT,                 -- sha256 of the source bytes
  r2_key TEXT,                       -- dd-watchlists/<provider>/<date>.json
  source_url TEXT,                   -- where we fetched it
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  duration_ms INTEGER,
  ok INTEGER NOT NULL DEFAULT 1,     -- 0 = refresh failed; last good still usable
  error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_dd_watchlist_cache_snap
  ON dd_watchlist_cache(provider, list_name, snapshot_date);
CREATE INDEX IF NOT EXISTS idx_dd_watchlist_cache_provider ON dd_watchlist_cache(provider, fetched_at DESC);

CREATE TABLE IF NOT EXISTS entity_risk_scores (
  entity_id INTEGER PRIMARY KEY,
  risk_score REAL NOT NULL DEFAULT 0,        -- 0..100; higher = riskier
  trust_score REAL NOT NULL DEFAULT 50,      -- 0..100; higher = more trustworthy
  risk_band TEXT NOT NULL DEFAULT 'unknown', -- low | medium | high | critical | unknown
  -- Counts per category — driven by `dd_findings` of `status IN ('open','confirmed')`.
  sanctions_count INTEGER NOT NULL DEFAULT 0,
  pep_count INTEGER NOT NULL DEFAULT 0,
  adverse_media_count INTEGER NOT NULL DEFAULT 0,
  court_case_count INTEGER NOT NULL DEFAULT 0,
  enforcement_count INTEGER NOT NULL DEFAULT 0,
  green_flag_count INTEGER NOT NULL DEFAULT 0,
  -- Score components — kept so the UI can show "why".
  components_json TEXT,                       -- {sanctions: 40, media: 10, ...}
  -- AI-generated 3-paragraph executive summary, refreshed alongside the
  -- score so the operator never sees a stale narrative next to fresh
  -- numbers.
  ai_summary TEXT,
  ai_summary_model TEXT,
  ai_summary_generated_at TEXT,
  -- Scan provenance.
  last_scan_id TEXT,                          -- uuid of the scan run
  last_scan_at TEXT,
  last_scan_duration_ms INTEGER,
  providers_scanned_json TEXT,                -- ["opensanctions","sec_edgar",...]
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entity_risk_band ON entity_risk_scores(risk_band);
CREATE INDEX IF NOT EXISTS idx_entity_risk_score ON entity_risk_scores(risk_score DESC);
CREATE INDEX IF NOT EXISTS idx_entity_risk_scan_at ON entity_risk_scores(last_scan_at);

-- Lightweight scan-run ledger so we can show "last scanned" and audit
-- when each run happened. One row per scan; multiple per entity over
-- time. Kept tiny so we can list/sort cheaply.
CREATE TABLE IF NOT EXISTS dd_scan_runs (
  id TEXT PRIMARY KEY,                          -- uuid
  entity_id INTEGER NOT NULL,
  trigger TEXT NOT NULL,                        -- "manual" | "cron" | "batch" | "workflow"
  triggered_by TEXT,                            -- reviewer email if manual
  status TEXT NOT NULL DEFAULT 'running',       -- running | ok | partial | failed
  providers_attempted_json TEXT,
  providers_failed_json TEXT,
  findings_added INTEGER NOT NULL DEFAULT 0,
  findings_resolved INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER,
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_dd_scan_runs_entity ON dd_scan_runs(entity_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_dd_scan_runs_status ON dd_scan_runs(status);
