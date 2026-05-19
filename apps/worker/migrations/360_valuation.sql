-- Task #9: Valuation Intelligence (Comps + Secondary Pricing).
--
-- Two cooperating subsystems land here:
--
--   1. valuation_marks — every observed valuation point for a private
--      company, from any source (primary funding round, secondary-
--      market indicative listing, 409A indicator, mutual-fund N-PORT
--      holding, markdown filing). Marks are IMMUTABLE: re-extracting a
--      newer point writes a fresh row with a later `as_of` rather than
--      mutating an existing one (mirrors the Task #5 snapshot rule).
--
--   2. comp_panels / comp_members / comp_metrics — analyst-built panels
--      of public-company peers. The panel carries the screen criteria
--      (sector / business model / ARR band / growth band) in
--      criteria_json; the engine re-screens monthly and refreshes
--      membership. Members carry the most recent multiples from
--      comp_metrics (EV/Revenue, EV/ARR, gross margin, Rule-of-40).
--
-- Migration numbering: spec said 350_valuation.sql but 350 is already
-- 350_lp_fund_commitments. Per repo convention (Task #5 used 359 for
-- the same reason), this lands at 360 — the next free slot after
-- 359_cap_tables. Documented as CONSTRAINT, not contract drift.
--
-- All fact writes from the valuation services route through `insertFact`
-- per the Task #1 canonical write decision. The structured rows on
-- these tables are the projection consumed by the mark-map UI and the
-- /api/companies/:id/marks endpoint; the corresponding facts on the
-- company entity feed profile summaries and persona matching.

-- ============================================================
-- valuation_marks: one row per observed valuation point.
-- IMMUTABLE: never UPDATEd; new marks supersede via `as_of`.
-- Confidence baselines (used for the confidence-weighted blended line):
--   primary_round         0.95
--   markdown              0.85   (mutual-fund / VC quarterly markdown)
--   mutual_fund_holding   0.70   (N-PORT XML, quarterly)
--   secondary_listing     0.50   (Forge / EquityZen / Hiive — indicative)
--   four_oh_nine_a        0.40   (job-posting strike-price inference, court filings)
-- ============================================================
CREATE TABLE IF NOT EXISTS valuation_marks (
  id                       TEXT PRIMARY KEY,
  company_entity_id        TEXT NOT NULL,
  company_name_raw         TEXT NOT NULL,
  as_of                    TEXT NOT NULL,            -- ISO date (YYYY-MM-DD)
  source_kind              TEXT NOT NULL,            -- primary_round | secondary_listing | four_oh_nine_a | mutual_fund_holding | markdown
  source_url               TEXT,
  source_ref               TEXT,                     -- accession_no | deal_id | listing_id
  implied_valuation_usd    INTEGER,                  -- post-money or implied total enterprise value
  share_price_usd          REAL,                     -- per-share price when known
  fully_diluted_shares     INTEGER,
  mark_kind                TEXT,                     -- post_money | pre_money | fmv | bid | ask | mid | nav
  confidence               REAL NOT NULL DEFAULT 0.5,
  holder_name_raw          TEXT,                     -- for mutual_fund_holding: the fund's name
  notes                    TEXT,
  raw_evidence_json        TEXT,
  dedupe_key               TEXT NOT NULL,            -- sha1(company_entity_id|source_kind|as_of|source_url|holder)
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (dedupe_key)
);
CREATE INDEX IF NOT EXISTS idx_valmark_company   ON valuation_marks(company_entity_id, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_valmark_source    ON valuation_marks(source_kind, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_valmark_asof      ON valuation_marks(as_of DESC);

-- ============================================================
-- comp_panels: analyst-built peer groups. Re-screened monthly.
-- criteria_json shape:
--   { "sector": "vertical_saas", "business_model": "saas",
--     "arr_min_usd": 20000000, "arr_max_usd": 100000000,
--     "growth_min_pct": 0.5, "geography": "US" }
-- All fields optional; missing field => unconstrained.
-- ============================================================
CREATE TABLE IF NOT EXISTS comp_panels (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  description              TEXT,
  criteria_json            TEXT NOT NULL,            -- screen definition
  created_by               TEXT,                     -- operator email
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_refreshed_at        TEXT,
  member_count             INTEGER NOT NULL DEFAULT 0,
  UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS idx_comppanel_refresh ON comp_panels(last_refreshed_at);

-- ============================================================
-- comp_members: snapshot of panel membership at last refresh.
-- public members carry computed multiples from comp_metrics; private
-- members carry inferred range from latest valuation_marks.
-- ============================================================
CREATE TABLE IF NOT EXISTS comp_members (
  id                       TEXT PRIMARY KEY,
  panel_id                 TEXT NOT NULL,
  company_entity_id        TEXT NOT NULL,
  company_name_raw         TEXT NOT NULL,
  is_public                INTEGER NOT NULL DEFAULT 0, -- 1 if public ticker, 0 if private
  ticker                   TEXT,
  added_at                 TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  removed_at               TEXT,
  match_reason             TEXT,                     -- which criteria matched
  FOREIGN KEY (panel_id) REFERENCES comp_panels(id) ON DELETE CASCADE,
  UNIQUE (panel_id, company_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_compmem_panel    ON comp_members(panel_id);
CREATE INDEX IF NOT EXISTS idx_compmem_entity   ON comp_members(company_entity_id);

-- ============================================================
-- comp_metrics: quarterly metrics for public-comp members.
-- One row per (company, quarter_end). Filled from 10-Q extractor.
-- ============================================================
CREATE TABLE IF NOT EXISTS comp_metrics (
  id                       TEXT PRIMARY KEY,
  company_entity_id        TEXT NOT NULL,
  quarter_end              TEXT NOT NULL,            -- ISO date (YYYY-MM-DD)
  source_url               TEXT,
  source_accession_no      TEXT,
  revenue_usd              INTEGER,                  -- TTM revenue
  arr_usd                  INTEGER,                  -- ARR when disclosed
  gross_margin_pct         REAL,
  net_dollar_retention_pct REAL,
  rule_of_40_pct           REAL,
  growth_yoy_pct           REAL,
  enterprise_value_usd     INTEGER,
  ev_revenue_multiple      REAL,                     -- EV / TTM revenue
  ev_arr_multiple          REAL,                     -- EV / ARR
  ticker                   TEXT,
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_entity_id, quarter_end)
);
CREATE INDEX IF NOT EXISTS idx_compmet_company  ON comp_metrics(company_entity_id, quarter_end DESC);
CREATE INDEX IF NOT EXISTS idx_compmet_quarter  ON comp_metrics(quarter_end DESC);
