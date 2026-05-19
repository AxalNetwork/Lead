-- Task #5: Cap-Table Inference Engine.
--
-- Approximates a private company's cap table from public artifacts
-- (S-1s, Delaware COIs, Form D, secondary listings, press). Snapshots
-- are IMMUTABLE — re-extracting a company emits a NEW row with a fresh
-- `as_of` date; old snapshots are preserved for the history timeline.
--
-- Migration numbering: the Task #5 spec literally wrote
-- "349_cap_tables.sql", but migration 349 already exists
-- (sec_edgar.sql, applied in production). To avoid colliding with an
-- applied migration we land cap tables at 359 — the next free slot
-- after 358_alert_rules_task4_kinds. This is a CONSTRAINT (the spec
-- could not anticipate the prior task's number), not a contract drift.
--
-- All fact writes from the inference services route through
-- `insertFact` per the Task #1 canonical write decision. The
-- snapshot/holders rows on this table are the structured projection
-- consumed by the cap-table API + UI tab — facts are written in
-- parallel so downstream alerts, profile summaries, and persona
-- matching pick up the new signal.

-- ============================================================
-- cap_table_snapshots: one row per (company, as_of, source_kind)
-- extraction. Immutable — never UPDATEd, never DELETEd by app code
-- once written. Confidence is set per source_kind:
--   s1_filing        = 0.95  (signed gold standard)
--   delaware_coi     = 0.70  (preferred-stock series + auth shares only)
--   form_d_inference = 0.55  (round size + investor names, no shares)
--   secondary_listing= 0.50  (Forge/EquityZen → approximate FMV)
--   press_inference  = 0.30  (round + lead investor only)
-- ============================================================
CREATE TABLE IF NOT EXISTS cap_table_snapshots (
  id                       TEXT PRIMARY KEY,
  company_entity_id        TEXT NOT NULL,
  company_name_raw         TEXT NOT NULL,
  as_of                    TEXT NOT NULL,            -- ISO date (YYYY-MM-DD)
  source_kind              TEXT NOT NULL,            -- s1_filing | delaware_coi | form_d_inference | secondary_listing | press_inference
  source_url               TEXT NOT NULL,
  source_accession_no      TEXT,                     -- SEC accession_no when source_kind=s1_filing or form_d_inference
  fully_diluted_shares     INTEGER,                  -- total FD share count (NULL when unknown)
  post_money_usd           INTEGER,                  -- implied post-money valuation in USD
  pre_money_usd            INTEGER,
  option_pool_pct          REAL,                     -- 0..1 fraction of FD reserved for options
  preferred_pct            REAL,                     -- 0..1 fraction of FD held by preferred holders
  common_pct               REAL,                     -- 0..1 fraction of FD held by common holders
  confidence               REAL NOT NULL DEFAULT 0.5,
  raw_evidence_json        TEXT,                     -- the parsed payload that produced this snapshot
  notes                    TEXT,
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (company_entity_id, as_of, source_kind, source_url)
);
CREATE INDEX IF NOT EXISTS idx_capsnap_company    ON cap_table_snapshots(company_entity_id, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_capsnap_source     ON cap_table_snapshots(source_kind, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_capsnap_accession  ON cap_table_snapshots(source_accession_no) WHERE source_accession_no IS NOT NULL;

-- ============================================================
-- cap_table_holders: per-holder rows for one snapshot. A snapshot may
-- have 0 holders (Form D inference can only assert round-size totals)
-- through ~200 (S-1 Principal Stockholders + Selling Stockholders).
--
-- holder_class is the human-readable bucket the UI groups by:
--   founder | preferred_investor | common_investor | employee_pool |
--   esop_unallocated | unknown
-- security_type is the legal instrument:
--   common | preferred_a | preferred_b | … | option | warrant | safe |
--   convertible_note
-- ============================================================
CREATE TABLE IF NOT EXISTS cap_table_holders (
  id                          TEXT PRIMARY KEY,
  snapshot_id                 TEXT NOT NULL,
  holder_entity_id            TEXT,                  -- resolved u_entities.id when match found
  holder_name_raw             TEXT NOT NULL,
  holder_name_normalized      TEXT,                  -- normalizeCompanyName / normalizePersonName output
  holder_class                TEXT NOT NULL DEFAULT 'unknown',
  security_type               TEXT,
  shares                      INTEGER,               -- share count for this row
  pct_ownership               REAL,                  -- 0..1 fraction of FD shares (snapshot-relative)
  original_investment_usd     INTEGER,
  round_acquired              TEXT,                  -- "Series B" | "Pre-Seed" | "Founder Grant" | …
  liquidation_preference_x    REAL,                  -- 1.0, 1.5, 2.0 … (NULL for common / unknown)
  participating               INTEGER,               -- 0/1 (NULL = unknown)
  notes                       TEXT,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (snapshot_id) REFERENCES cap_table_snapshots(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_capholder_snap     ON cap_table_holders(snapshot_id);
CREATE INDEX IF NOT EXISTS idx_capholder_entity   ON cap_table_holders(holder_entity_id) WHERE holder_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_capholder_norm     ON cap_table_holders(holder_name_normalized);
CREATE INDEX IF NOT EXISTS idx_capholder_class    ON cap_table_holders(snapshot_id, holder_class);
