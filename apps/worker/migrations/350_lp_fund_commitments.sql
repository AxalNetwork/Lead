-- Task #2: LP Disclosure Crawler — per-fund commitment ledger.
--
-- One row per (LP, fund_name_raw, as_of_date) — i.e. one disclosed
-- commitment row in one LP's quarterly/annual PE program report. The
-- table is the structured ledger that the API routes pivot over:
--   - /api/lps/:id/commitments       — index over (lp_entity_id, as_of_date)
--   - /api/funds/:id/known-lps       — index over (fund_entity_id, as_of_date)
--   - /api/firms/:id/lp-mix          — index over (gp_firm_entity_id, as_of_date)
--
-- Idempotency: UNIQUE(lp_entity_id, fund_name_raw, as_of_date) lets the
-- persister `INSERT OR REPLACE` so re-running a disclosure overwrites the
-- same row instead of appending duplicates. All entity / fact writes
-- (LP entity, fund entity, firm AUM corroboration) route through the
-- canonical `insertFact` path — adapters never INSERT into this table
-- or u_entities directly.
--
-- Platform-global. No owner_user_id — the LP-GP network is the same for
-- every operator.

CREATE TABLE IF NOT EXISTS lp_fund_commitments (
  id                   TEXT PRIMARY KEY,        -- uuid v4
  lp_entity_id         TEXT NOT NULL,           -- u_entities.id (the LP)
  fund_entity_id       TEXT,                    -- u_entities.id (resolved fund), NULL until resolver matches
  fund_name_raw        TEXT NOT NULL,           -- exact string as disclosed
  gp_firm_entity_id    TEXT,                    -- u_entities.id (managing GP firm), NULL until resolver matches
  vintage_year         INTEGER,
  committed_usd        REAL,
  called_usd           REAL,                    -- alias: contributions / paid-in
  distributed_usd      REAL,
  nav_usd              REAL,                    -- remaining value / market value
  net_irr_pct          REAL,                    -- e.g. 18.4 (not 0.184)
  tvpi                 REAL,                    -- (distributed + nav) / committed
  dpi                  REAL,                    -- distributed / committed
  as_of_date           TEXT NOT NULL,           -- ISO date the disclosure measures (period end)
  source_id            TEXT,                    -- adapter id (e.g. "lp_calpers")
  source_url           TEXT,                    -- canonical URL of the disclosure
  source_filing_date   TEXT,                    -- ISO date the report was published
  confidence           REAL NOT NULL DEFAULT 0.5,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (lp_entity_id, fund_name_raw, as_of_date)
);

CREATE INDEX IF NOT EXISTS idx_lpfc_lp_asof
  ON lp_fund_commitments(lp_entity_id, as_of_date DESC);
CREATE INDEX IF NOT EXISTS idx_lpfc_fund_asof
  ON lp_fund_commitments(fund_entity_id, as_of_date DESC)
  WHERE fund_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lpfc_gp_asof
  ON lp_fund_commitments(gp_firm_entity_id, as_of_date DESC)
  WHERE gp_firm_entity_id IS NOT NULL;
-- Used by /api/firms/:id/lp-mix to count distinct LPs per GP without a
-- secondary scan.
CREATE INDEX IF NOT EXISTS idx_lpfc_gp_lp
  ON lp_fund_commitments(gp_firm_entity_id, lp_entity_id)
  WHERE gp_firm_entity_id IS NOT NULL;
