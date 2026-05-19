-- Task #2: Fund-Return Modeling (DPI / MOIC Inference).
--
-- One row per (fund_id, model_version) per nightly run. Append-only:
-- the latest row per fund is "current" for read paths; prior versions
-- are retained for audit (delta-vs-actual diagnostics, calibration
-- regression tracking).
--
-- Migration numbering: spec said 352, but slots 350-365 are all taken
-- (per replit.md Task #13 / #14 / #18 contract-update precedent). This
-- lands at 366 — the next free slot after 365_preferred_stack.
-- Documented as a contract update in replit.md. Future migrations
-- should number from 367.
--
-- All derived business facts (`fund.dpi`, `fund.tvpi`, `fund.moic`,
-- `fund.net_irr_pct`, `fund.return_confidence`) flow through
-- `insertFact` per the Task #1 canonical write contract, with
-- source_kind="inferred" (the existing enum value that best matches
-- model output — there is no dedicated "model" kind).

CREATE TABLE IF NOT EXISTS fund_return_models (
  id                       TEXT PRIMARY KEY,         -- uuid v4
  fund_id                  TEXT NOT NULL,            -- funds.id
  model_version            TEXT NOT NULL,            -- semver of services/fundReturns/model.ts
  as_of                    TEXT NOT NULL,            -- ISO date the model run measures (typically run-day)
  -- Inputs
  committed_usd            REAL,                     -- fund total commitment (announced_raised_usd or LP-summed)
  called_usd               REAL,                     -- inferred called capital (invested + fee drag)
  invested_usd             REAL,                     -- sum of position_usd across portfolio
  fee_drag_usd             REAL,                     -- 2%/yr × years × committed
  -- Outputs (cashflow projection)
  distributed_usd          REAL NOT NULL DEFAULT 0,  -- sum of realized proceeds (IPO + M&A + bankruptcy=0)
  residual_value_usd       REAL NOT NULL DEFAULT 0,  -- sum of last_mark × ownership for unexited
  -- Metrics
  dpi                      REAL,                     -- distributed / called
  tvpi                     REAL,                     -- (distributed + residual) / called
  moic                     REAL,                     -- (distributed + residual) / invested
  net_irr_pct              REAL,                     -- simplified annualized return; null when duration unknown
  -- Coverage / confidence
  positions_total          INTEGER NOT NULL DEFAULT 0,
  positions_resolved       INTEGER NOT NULL DEFAULT 0, -- count with classified liquidity event
  resolved_coverage_pct    REAL,                     -- positions_resolved / positions_total
  confidence               TEXT NOT NULL DEFAULT 'low', -- high | medium | low
  -- Calibration (Task #95 dependency — may be null until LP actuals exist)
  bias_correction_applied  REAL,                     -- multiplier baked into outputs (1.0 = none)
  delta_vs_actual_json     TEXT,                     -- {tvpi: {actual: x, modeled: y, delta: z}, …} when matched
  -- Attribution (top-5 TVPI contributors at this run)
  attribution_json         TEXT NOT NULL,            -- [{company_entity_id, company_name, contribution_usd, share_pct, event_kind}]
  warnings_json            TEXT,                     -- string[] — missing-input notes
  created_at               TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (fund_id, as_of, model_version)
);
CREATE INDEX IF NOT EXISTS idx_fund_return_fund_ts ON fund_return_models(fund_id, as_of DESC);
CREATE INDEX IF NOT EXISTS idx_fund_return_created ON fund_return_models(created_at DESC);

-- Per-vintage / strategy bias corrections derived from the modeled-vs-
-- actual gap on funds with disclosed LP returns. Recomputed nightly
-- after the model run. One row per (vintage_year, strategy) bucket.
-- strategy_key: NEVER NULL — empty string '' means "strategy-agnostic
-- bucket". This is critical because SQLite/D1 treats NULL values as
-- distinct under UNIQUE constraints, which would let ON CONFLICT skip
-- the upsert and silently append duplicate rows on every nightly run.
-- Lookup helpers translate caller-supplied NULL → '' on both write and
-- read paths.
CREATE TABLE IF NOT EXISTS fund_return_calibration (
  id                       TEXT PRIMARY KEY,
  vintage_year             INTEGER NOT NULL,
  strategy_key             TEXT NOT NULL DEFAULT '', -- '' = strategy-agnostic
  sample_size              INTEGER NOT NULL DEFAULT 0,
  median_delta_tvpi        REAL,                     -- modeled - actual TVPI median
  median_delta_dpi         REAL,
  bias_correction          REAL NOT NULL DEFAULT 1.0,-- multiplier applied to modeled TVPI on next run
  computed_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (vintage_year, strategy_key)
);
CREATE INDEX IF NOT EXISTS idx_fund_return_calib_vintage ON fund_return_calibration(vintage_year, strategy_key);
