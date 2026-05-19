-- Task #5: Investor Reputation + Founder CRM (Founder-Side).
--
-- Migration numbering: spec text said 365, but 365 is already taken
-- by Task #18 (preferred-stack) and slots 366-369 are also occupied
-- (Task #2 fund returns / Task #3 edge quality x2 / Task #4 intros).
-- This lands at 370, the next free slot. Future migrations should
-- number from 371. See replit.md Task #5 contract-update note.
--
-- Four tables:
--   1. investor_reputation        — one row per investor with reputation
--                                    aggregates. Refreshed nightly.
--                                    Public visibility gated by sample_size >= 5.
--   2. founder_pipelines          — founder-owned raise pipelines.
--                                    Private to owner_email.
--   3. founder_pipeline_investors — kanban cards per investor in pipeline,
--                                    with stage + last touch + notes.
--   4. founder_feedback           — anonymous founder reviews of investors.
--                                    Source identity stripped before persist.

CREATE TABLE IF NOT EXISTS investor_reputation (
  investor_entity_id           TEXT PRIMARY KEY,
  -- Behavior signals (NULL when sample insufficient).
  speed_to_no_days_median      REAL,           -- median days from first contact to pass
  term_aggressiveness_pct      REAL,           -- 0..1 percentile vs peer cohort (Task #18 input)
  follow_on_rate_pct           REAL,           -- 0..1 — % of seed cos reinvested at Series A
  board_behavior_score         REAL,           -- 0..1 aggregated NPS
  founder_nps                  REAL,           -- -100..100 from founder_feedback
  reneged_term_sheets_count    INTEGER NOT NULL DEFAULT 0,
  portfolio_conflict_count     INTEGER NOT NULL DEFAULT 0, -- competing portcos
  -- Sample sizes per signal so the UI can honestly say "low confidence".
  sample_size                  INTEGER NOT NULL DEFAULT 0, -- founder_feedback rows
  speed_to_no_n                INTEGER NOT NULL DEFAULT 0,
  follow_on_n                  INTEGER NOT NULL DEFAULT 0,
  -- Min sample gate per spec: aggregates only public when >=5 reviews.
  is_public                    INTEGER NOT NULL DEFAULT 0,
  low_sample                   INTEGER NOT NULL DEFAULT 1,
  computed_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_invrep_public ON investor_reputation(is_public, computed_at DESC);

CREATE TABLE IF NOT EXISTS founder_pipelines (
  id                  TEXT PRIMARY KEY,
  owner_email         TEXT NOT NULL,           -- private to this founder
  founder_entity_id   TEXT,                    -- u_entities.id if resolved; powers intro suggestions
  raise_purpose       TEXT NOT NULL,           -- "Seed for AI infra co" / free text
  target_round        TEXT,                    -- "Seed" | "Series A" | …
  target_amount_usd   REAL,
  status              TEXT NOT NULL DEFAULT 'open', -- open | closed | abandoned
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_fpipe_owner ON founder_pipelines(owner_email, status, updated_at DESC);

-- Kanban stages enforced at the application layer (typed string).
-- Stage transitions are journaled in founder_pipeline_events for analytics.
CREATE TABLE IF NOT EXISTS founder_pipeline_investors (
  id                  TEXT PRIMARY KEY,
  pipeline_id         TEXT NOT NULL,
  investor_entity_id  TEXT NOT NULL,
  stage               TEXT NOT NULL DEFAULT 'not_contacted',
  -- not_contacted | intro_requested | first_meeting | diligence |
  -- partners_meeting | term_sheet | committed | passed | ghosted
  last_touch_at       TEXT,
  next_step           TEXT,
  notes               TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES founder_pipelines(id) ON DELETE CASCADE,
  UNIQUE (pipeline_id, investor_entity_id)
);
CREATE INDEX IF NOT EXISTS idx_fpi_pipe  ON founder_pipeline_investors(pipeline_id, stage);
CREATE INDEX IF NOT EXISTS idx_fpi_inv   ON founder_pipeline_investors(investor_entity_id);

-- Append-only journal of stage transitions; powers later analytics
-- on time-in-stage and conversion funnels (Task #5 step 4).
CREATE TABLE IF NOT EXISTS founder_pipeline_events (
  id                  TEXT PRIMARY KEY,
  pipeline_id         TEXT NOT NULL,
  pipeline_investor_id TEXT NOT NULL,
  from_stage          TEXT,
  to_stage            TEXT NOT NULL,
  occurred_at         TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (pipeline_id) REFERENCES founder_pipelines(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_fpe_pipe ON founder_pipeline_events(pipeline_id, occurred_at DESC);

-- Anonymous founder feedback. The submitter's email/identity is NEVER
-- written here — only a one-way hash (submitter_hash) bound to the
-- (investor, raise_year) pair so we can detect blatant duplicate
-- ballot-stuffing without re-identifying the submitter. The application
-- layer is responsible for hashing BEFORE the INSERT; this table holds
-- no PII at rest.
CREATE TABLE IF NOT EXISTS founder_feedback (
  id                  TEXT PRIMARY KEY,
  investor_entity_id  TEXT NOT NULL,
  raise_year          INTEGER,                 -- yyyy bucket; coarse on purpose
  raise_outcome       TEXT,                    -- closed | passed | ghosted | reneged
  terms_summary       TEXT,                    -- short free-text (operator-moderated)
  behavior_rating     INTEGER,                 -- 1..5 NPS-style
  speed_to_no_days    INTEGER,                 -- nullable; founder-reported
  free_text           TEXT,
  submitter_hash      TEXT NOT NULL,           -- sha256(submitter_email || ":" || investor || ":" || year)
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (submitter_hash)
);
CREATE INDEX IF NOT EXISTS idx_ff_investor ON founder_feedback(investor_entity_id, created_at DESC);
