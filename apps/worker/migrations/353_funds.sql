-- Task #3: Fund Intelligence Engine.
--
-- Per-fund structured ledger assembling Form ADV Item 7 (one row per
-- managed fund), Form D filings, LP-disclosed commitments, press
-- releases, and deal-flow events into a single canonical record. All
-- firm-level facts (AUM, latest-vintage, strategy_drift) flow through
-- the canonical `insertFact` path; this table is the structured ledger
-- only.
--
-- Idempotency: UNIQUE(firm_entity_id, fund_name) — the assembler
-- INSERT-OR-UPDATEs the same row on every refresh. fund_id_807 is a
-- second discriminator when the SEC-issued fund identifier is known
-- (assembler stamps it as a fact + uses it for resolver hits) but the
-- UNIQUE key stays (firm, name) because not every fund has an 807.

CREATE TABLE IF NOT EXISTS funds (
  id                       TEXT PRIMARY KEY,         -- uuid v4
  firm_entity_id           TEXT NOT NULL,            -- u_entities.id of managing GP firm
  fund_entity_id           TEXT,                     -- u_entities.id of the fund entity (resolved via fundResolver)
  fund_name                TEXT NOT NULL,            -- canonical fund name
  fund_number              INTEGER,                  -- e.g. 4 for "Fund IV"
  vintage_year             INTEGER,
  target_size_usd          REAL,
  hard_cap_usd             REAL,
  first_close_date         TEXT,                     -- ISO date
  final_close_date         TEXT,                     -- ISO date
  announced_raised_usd     REAL,
  gp_commit_usd            REAL,
  mgmt_fee_pct             REAL,                     -- e.g. 2.0
  carry_pct                REAL,                     -- e.g. 20.0
  hurdle_pct               REAL,                     -- e.g. 8.0
  strategy                 TEXT,                     -- seed | early | growth | late | buyout | growth_equity | secondary | fund_of_funds | credit
  sectors_json             TEXT,                     -- JSON array
  geos_json                TEXT,                     -- JSON array
  fund_status              TEXT NOT NULL DEFAULT 'active', -- raising | active | harvesting | wound_down
  source_evidence_json     TEXT,                     -- JSON array of {field, value, source_type, source_url, observed_at}
  confidence               REAL NOT NULL DEFAULT 0.5,
  updated_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (firm_entity_id, fund_name)
);

CREATE INDEX IF NOT EXISTS idx_funds_firm       ON funds(firm_entity_id);
CREATE INDEX IF NOT EXISTS idx_funds_status     ON funds(fund_status, target_size_usd DESC);
CREATE INDEX IF NOT EXISTS idx_funds_vintage    ON funds(vintage_year, strategy);
CREATE INDEX IF NOT EXISTS idx_funds_strategy   ON funds(strategy, vintage_year DESC);
CREATE INDEX IF NOT EXISTS idx_funds_fund_ent   ON funds(fund_entity_id) WHERE fund_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_funds_updated    ON funds(updated_at);
