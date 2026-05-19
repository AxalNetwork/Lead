-- Task #18: Term-Sheet Intelligence.
--
-- Migration numbering: spec text said 351, but 351-364 are already
-- taken (see replit.md Task #13/#14 contract-update notes). This
-- lands at 365, the next free slot. Future migrations should number
-- from 366.
--
-- Three cooperating tables:
--   1. preferred_series         — one row per (company, series_name)
--                                  observation. Supersedes-chain:
--                                  re-extraction or 8-K Item 3.03
--                                  modification inserts a new row and
--                                  marks the prior one is_current=0.
--   2. preferred_series_investors — many-to-many series ↔ investor
--                                  with lead flag. Investors are best-
--                                  effort resolved to u_entities.id at
--                                  write time; rows without a resolved
--                                  investor entity are NOT written
--                                  (raw_name kept on the parent row's
--                                  payload_json for forensics).
--   3. term_benchmarks          — one row per (stage, sector, year)
--                                  bucket; populated by the nightly
--                                  benchmark rebuilder. Powers
--                                  /api/term-benchmarks and per-term
--                                  percentile pills on the preferred
--                                  stack panel.
--
-- Per the Task #1 canonical write contract, derived per-term facts
-- (preferred_series.lp_x, preferred_series.participating, …) are
-- mirrored onto the company entity via insertFact in the persist
-- layer — never directly into the facts table from SQL.

CREATE TABLE IF NOT EXISTS preferred_series (
  id                          TEXT PRIMARY KEY,
  company_entity_id           TEXT NOT NULL,
  series_name                 TEXT NOT NULL,       -- normalized: "Series A", "Series A-1", "Series Seed"
  series_letter               TEXT,                -- "A", "A-1", "Seed", "Pre-Seed"
  original_issue_price_usd    REAL,
  pre_money_usd               REAL,
  raise_amount_usd            REAL,
  liquidation_pref_x          REAL,                -- 1.0, 1.5, 2.0, 3.0
  participating               INTEGER,             -- 0 | 1 | NULL (unknown)
  participating_cap_x         REAL,                -- multiple-of-OIP cap; NULL when uncapped or non-participating
  anti_dilution               TEXT,                -- 'full_ratchet' | 'broad_weighted' | 'narrow_weighted' | 'none'
  dividend_rate_pct           REAL,                -- 0.06 = 6% per annum
  dividend_cumulative         INTEGER,             -- 0 | 1 | NULL
  conversion_ratio            REAL,                -- shares of common per share of preferred
  protective_provisions_count INTEGER,             -- count of separate-class veto items enumerated
  redemption_rights           INTEGER,             -- 0 | 1 | NULL
  board_total                 INTEGER,
  board_investor_seats        INTEGER,
  board_founder_seats         INTEGER,
  board_independent_seats     INTEGER,
  stage                       TEXT,                -- 'pre_seed' | 'seed' | 'series_a' | 'series_b' | 'series_c' | 'series_d_plus'
  sector                      TEXT,                -- best-effort; copied from facts at write time
  closing_date                TEXT,                -- ISO yyyy-mm-dd; for 8-K mods this is the event_date
  confidence                  REAL NOT NULL DEFAULT 0.7,
  source_kind                 TEXT NOT NULL,       -- 'filing' | 'press' | 'import'  (re-uses existing enum)
  source                      TEXT NOT NULL,       -- 'sec:s1' | 'sec:8k_3.03' | 'document:termSheetParser' | 'delaware_coi' | 'press_leak'
  source_url                  TEXT,
  source_accession_no         TEXT,
  is_current                  INTEGER NOT NULL DEFAULT 1,
  superseded_by               TEXT,
  payload_json                TEXT,                -- full parsed payload incl. raw investor names + protective provision list
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pref_company      ON preferred_series(company_entity_id, is_current);
CREATE INDEX IF NOT EXISTS idx_pref_series       ON preferred_series(company_entity_id, series_name, is_current);
CREATE INDEX IF NOT EXISTS idx_pref_bucket       ON preferred_series(stage, sector, substr(closing_date, 1, 4), is_current);
CREATE INDEX IF NOT EXISTS idx_pref_source       ON preferred_series(source_accession_no);

CREATE TABLE IF NOT EXISTS preferred_series_investors (
  id                          TEXT PRIMARY KEY,
  series_id                   TEXT NOT NULL,
  investor_entity_id          TEXT NOT NULL,
  is_lead                     INTEGER NOT NULL DEFAULT 0,
  raw_name                    TEXT,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (series_id) REFERENCES preferred_series(id) ON DELETE CASCADE,
  UNIQUE (series_id, investor_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_psi_series        ON preferred_series_investors(series_id);
CREATE INDEX IF NOT EXISTS idx_psi_investor      ON preferred_series_investors(investor_entity_id, is_lead);

CREATE TABLE IF NOT EXISTS term_benchmarks (
  id                          TEXT PRIMARY KEY,
  stage                       TEXT NOT NULL,
  sector                      TEXT NOT NULL,
  year                        INTEGER NOT NULL,
  sample_size                 INTEGER NOT NULL,
  pct_lp_1x                   REAL,
  pct_lp_gt_1x                REAL,
  pct_participating           REAL,
  pct_participating_capped    REAL,
  pct_uncapped_participating  REAL,
  pct_full_ratchet            REAL,
  pct_broad_weighted          REAL,
  pct_narrow_weighted         REAL,
  median_board_size           REAL,
  median_lp_x                 REAL,
  payload_json                TEXT,                -- per-term distributions for percentile lookup
  rebuilt_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (stage, sector, year)
);
CREATE INDEX IF NOT EXISTS idx_bench_bucket      ON term_benchmarks(stage, sector, year);
