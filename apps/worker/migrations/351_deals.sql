-- Task #3: Deal Flow & Funding Round Aggregator.
--
-- Two structured tables that form the platform-global deal ledger:
--
--   deal_events       — one row per (company, round_name, month_bucket).
--                       UNIQUE(dedupe_key) is the corroboration pivot:
--                       multiple sources for the same key collapse into
--                       the same row (status flips provisional →
--                       corroborated, or disputed on hard-field conflict).
--   deal_participants — one row per (deal, investor) with role.
--
-- All entity / fact writes (company, investor, derived totals) route
-- through `insertFact` / `createEntity` per the replit.md Task #1
-- decision; this migration only defines the structured ledger tables.
--
-- Sources_json on deal_events keeps every contributing URL with its
-- source_type so the UI can render the full citation trail without a
-- secondary fact lookup. Per-field canonical values follow the source-
-- authority hierarchy: sec_filing > company_blog > press_release >
-- tech_press (resolved in services/deals/persist.ts).

CREATE TABLE IF NOT EXISTS deal_events (
  id                   TEXT PRIMARY KEY,        -- uuid v4
  event_type           TEXT NOT NULL,           -- funding_round | acquisition | merger | ipo | secondary | spinout | recapitalization | bankruptcy
  company_entity_id    TEXT,                    -- u_entities.id (resolved), NULL if unresolved
  company_name_raw     TEXT NOT NULL,           -- exact string as observed in the canonical source
  company_name_normalized TEXT NOT NULL,        -- normalized for dedupe_key (lower-case, suffixes stripped)
  round_name           TEXT,                    -- Pre-Seed | Seed | Series A..N | Bridge | Extension | PIPE | NULL
  amount_usd           REAL,                    -- canonical amount (from highest-authority source)
  amount_raw           TEXT,                    -- raw amount string as observed (e.g. "$120M")
  valuation_usd        REAL,
  valuation_type       TEXT,                    -- pre_money | post_money | unknown | NULL
  announcement_date    TEXT,                    -- ISO date
  closing_date         TEXT,                    -- ISO date
  sector_tags_json     TEXT,                    -- JSON array of tag strings
  stage_tags_json      TEXT,                    -- JSON array of tag strings
  geography            TEXT,                    -- free-form (e.g. "San Francisco, CA" or "London, UK")
  use_of_proceeds      TEXT,                    -- short prose
  source_url           TEXT,                    -- canonical (highest-authority) source URL
  source_type          TEXT,                    -- sec_filing | company_blog | press_release | tech_press
  source_published_at  TEXT,                    -- ISO timestamp the canonical source published
  sources_json         TEXT,                    -- JSON array of {url, source_type, published_at, amount_usd, announcement_date}
  confidence           REAL NOT NULL DEFAULT 0.5,
  dedupe_key           TEXT NOT NULL UNIQUE,    -- sha256(normalized_company + round_name + month_bucket)
  status               TEXT NOT NULL DEFAULT 'provisional', -- provisional | corroborated | disputed
  created_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_deal_events_company_date
  ON deal_events(company_entity_id, announcement_date DESC)
  WHERE company_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deal_events_date
  ON deal_events(announcement_date DESC);

CREATE INDEX IF NOT EXISTS idx_deal_events_event_type_date
  ON deal_events(event_type, announcement_date DESC);

CREATE INDEX IF NOT EXISTS idx_deal_events_status
  ON deal_events(status, announcement_date DESC);


CREATE TABLE IF NOT EXISTS deal_participants (
  id                  TEXT PRIMARY KEY,
  deal_id             TEXT NOT NULL,            -- deal_events.id
  investor_entity_id  TEXT,                     -- u_entities.id (resolved)
  investor_name_raw   TEXT NOT NULL,            -- exact string as observed
  role                TEXT NOT NULL DEFAULT 'participating', -- lead | participating | follow_on
  position_usd        REAL,
  source_url          TEXT,
  source_type         TEXT,
  confidence          REAL NOT NULL DEFAULT 0.5,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (deal_id, investor_name_raw, role)
);

CREATE INDEX IF NOT EXISTS idx_deal_participants_investor_deal
  ON deal_participants(investor_entity_id, deal_id)
  WHERE investor_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deal_participants_deal
  ON deal_participants(deal_id);
