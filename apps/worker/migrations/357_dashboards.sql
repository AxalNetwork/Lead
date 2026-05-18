-- Task #4 (VC / PE / Angel Intelligence Dashboard): immutable dashboard
-- snapshots. The only new table this task introduces — every other
-- dashboard reads from existing tables (deal_events, partner_movements,
-- funds, lp_fund_commitments, pe_deals, sec_filings, angels).
--
-- A snapshot freezes the rendered payload of a dashboard page at a
-- point in time (filters + result set + optional chart-config). The
-- read path serves the row verbatim — it does NOT re-query the
-- underlying tables. This is the "snapshot URL renders the same chart
-- days later, even after underlying data changes" acceptance probe.
--
-- payload_uri points at an R2 object in the UPLOADS bucket
-- (path "dashboards/snapshots/<id>.json") when the payload exceeds the
-- D1 row-size budget; small payloads are inlined in payload_json.

CREATE TABLE IF NOT EXISTS dashboard_snapshots (
  id              TEXT PRIMARY KEY,
  owner_email     TEXT NOT NULL,
  page            TEXT NOT NULL,             -- "capital-markets" | "funds-raising" | "lp-network" | …
  filters_json    TEXT NOT NULL,             -- exact filter state at snapshot time (URL search params)
  payload_json    TEXT,                      -- inline payload (for small responses)
  payload_uri     TEXT,                      -- R2 path when payload is too large for D1
  row_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_owner
  ON dashboard_snapshots(owner_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dashboard_snapshots_page
  ON dashboard_snapshots(page, created_at DESC);
