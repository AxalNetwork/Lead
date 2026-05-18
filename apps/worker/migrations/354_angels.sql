-- Task #4: Angel & Syndicate Network Mapper.
--
-- Per-angel and per-syndicate ledger assembled from AngelList public
-- pages, Form D SPV filings (one-LLC angel vehicles), Twitter/X bios,
-- Crunchbase investor pages, deal-flow events, and public angel lists.
-- All entity-level facts (person.is_angel, person.angel_day_job,
-- person.angel_domain_expertise) flow through canonical `insertFact`
-- per the Task #1 contract; these tables are the operational ledger.
--
-- Idempotency:
--   angels                 PRIMARY KEY (person_entity_id)
--   angel_investments      UNIQUE (person_entity_id, dedupe_key)
--   syndicates             PRIMARY KEY (handle)
--   syndicate_backers      PRIMARY KEY (syndicate_handle, backer_entity_id)

CREATE TABLE IF NOT EXISTS angels (
  person_entity_id            TEXT PRIMARY KEY,         -- u_entities.id (kind='person')
  angel_type                  TEXT,                     -- solo_capitalist | operator_angel | super_angel | syndicate_lead | rolling_fund_manager | casual_angel
  classifier_confidence       REAL,                     -- 0..1 from classifyAngel
  day_job_entity_id           TEXT,                     -- u_entities.id of current employer (when resolved)
  day_job_role                TEXT,                     -- C-level / VP / Director / etc.
  typical_check_min_usd       REAL,
  typical_check_max_usd       REAL,
  preferred_stages_json       TEXT,                     -- JSON array (pre_seed, seed, series_a, ...)
  preferred_sectors_json      TEXT,                     -- JSON array
  preferred_geos_json         TEXT,                     -- JSON array
  portfolio_count             INTEGER NOT NULL DEFAULT 0,
  disclosed_investments_count INTEGER NOT NULL DEFAULT 0,
  syndicate_handle            TEXT,                     -- AngelList syndicate slug, when applicable
  rolling_fund_handle         TEXT,                     -- AngelList rolling-fund slug
  domain_expertise_tags_json  TEXT,                     -- JSON array of {tag, source: 'day_job_firm'|'role'|'investment_pattern'}
  last_investment_at          TEXT,                     -- ISO date of most recent disclosed investment
  open_to_warm_intros         INTEGER NOT NULL DEFAULT 0, -- 0|1 — derived from explicit bio signal
  source_evidence_json        TEXT,                     -- JSON array of {field, value, source_type, source_url, observed_at}
  confidence                  REAL NOT NULL DEFAULT 0.5,
  updated_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at                  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_refreshed_at           TEXT
);

CREATE INDEX IF NOT EXISTS idx_angels_type          ON angels(angel_type);
CREATE INDEX IF NOT EXISTS idx_angels_last_inv      ON angels(last_investment_at DESC);
CREATE INDEX IF NOT EXISTS idx_angels_day_job       ON angels(day_job_entity_id) WHERE day_job_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_angels_syndicate     ON angels(syndicate_handle) WHERE syndicate_handle IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_angels_rolling_fund  ON angels(rolling_fund_handle) WHERE rolling_fund_handle IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_angels_check         ON angels(typical_check_min_usd, typical_check_max_usd);
CREATE INDEX IF NOT EXISTS idx_angels_open_warm     ON angels(open_to_warm_intros, last_investment_at DESC);

-- Per-angel disclosed investment row. Dedupe key is the same as the
-- deal aggregator (sha256(normalized_company|event_type|round|month)),
-- so an SPV filing + press release for the same round collapse to one
-- row per (angel, deal). `via_syndicate_handle` is NULL when the angel
-- invested directly.
CREATE TABLE IF NOT EXISTS angel_investments (
  id                   TEXT PRIMARY KEY,                -- uuid v4
  person_entity_id     TEXT NOT NULL,                   -- u_entities.id (kind='person')
  company_entity_id    TEXT,                            -- u_entities.id (resolved)
  company_name_raw     TEXT NOT NULL,
  amount_usd           REAL,                            -- the angel's check (NULL if only round size known)
  round_name           TEXT,
  role                 TEXT NOT NULL DEFAULT 'participant', -- lead | participant | follow_on
  via_syndicate_handle TEXT,                            -- syndicates.handle when invested through a SPV/syndicate
  announced_at         TEXT,                            -- ISO date the round was announced
  observed_at          TEXT NOT NULL DEFAULT (datetime('now')),
  source_url           TEXT,
  source_type          TEXT,                            -- sec_filing | press_release | tech_press | social_bio | crunchbase
  dedupe_key           TEXT NOT NULL,                   -- shared with deal_events.dedupe_key
  deal_event_id        TEXT,                            -- deal_events.id when corroborated
  confidence           REAL NOT NULL DEFAULT 0.5,
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (person_entity_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS idx_ai_person_date  ON angel_investments(person_entity_id, announced_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_company      ON angel_investments(company_entity_id) WHERE company_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_syndicate    ON angel_investments(via_syndicate_handle) WHERE via_syndicate_handle IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ai_deal_event   ON angel_investments(deal_event_id) WHERE deal_event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS syndicates (
  handle                  TEXT PRIMARY KEY,             -- AngelList syndicate slug
  display_name            TEXT,
  lead_angel_entity_id    TEXT,                         -- u_entities.id (kind='person') of syndicate lead
  focus_sectors_json      TEXT,                         -- JSON array
  focus_stages_json       TEXT,                         -- JSON array
  geos_json               TEXT,
  backer_count            INTEGER NOT NULL DEFAULT 0,
  deals_count             INTEGER NOT NULL DEFAULT 0,
  last_deal_at            TEXT,                         -- ISO date
  avg_raise_usd           REAL,
  median_check_usd        REAL,
  velocity_per_quarter    REAL,                         -- trailing 4-quarter deals/quarter
  source_evidence_json    TEXT,
  updated_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at              TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_synd_lead       ON syndicates(lead_angel_entity_id) WHERE lead_angel_entity_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_synd_velocity   ON syndicates(velocity_per_quarter DESC);
CREATE INDEX IF NOT EXISTS idx_synd_lastdeal   ON syndicates(last_deal_at DESC);

-- Per-syndicate backer LP roster derived from SPV Form D `related_persons`
-- (single-LLC angel vehicles). Used for syndicate_overlap analytics.
CREATE TABLE IF NOT EXISTS syndicate_backers (
  syndicate_handle  TEXT NOT NULL,
  backer_entity_id  TEXT NOT NULL,
  backer_name_raw   TEXT,
  source_url        TEXT,
  observed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (syndicate_handle, backer_entity_id)
);

CREATE INDEX IF NOT EXISTS idx_synd_backers_backer ON syndicate_backers(backer_entity_id);
