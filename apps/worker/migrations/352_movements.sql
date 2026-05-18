-- Task #2 (People-at-Firms Tracker): partner-movement ledger.
--
-- Three structured tables that form the movement ledger:
--
--   firm_team_snapshots — append-only weekly snapshot of a firm's team
--                         page. members_json is the normalized list of
--                         {entity_id?, name, role_title?, profile_url?}.
--                         UNIQUE(firm_entity_id, snapshot_date) gives
--                         per-week idempotency.
--
--   partner_movements   — diffed events between two snapshots. One row
--                         per (person, from_firm, to_firm, movement_type,
--                         month_bucket) via UNIQUE(dedupe_key).
--                         status: provisional -> confirmed (≥1
--                         corroborating signal) or rejected (operator
--                         override).
--
--   fund_spinouts       — emitted when ≥2 confirmed 'left' events share
--                         a from_firm_entity_id within a 90-day window
--                         and a new firm appears whose team includes
--                         ≥2 of those people.
--
-- Per-entity facts (person current firm, current title, firm
-- carry_breadth) route through `insertFact` (canonical write path per
-- replit.md Task #1 decision). These tables are the operational ledger
-- only; they are not the source of truth for those facts.

CREATE TABLE IF NOT EXISTS firm_team_snapshots (
  id                  TEXT PRIMARY KEY,            -- uuid v4
  firm_entity_id      TEXT NOT NULL,               -- u_entities.id
  snapshot_date       TEXT NOT NULL,               -- ISO date (YYYY-MM-DD)
  source_url          TEXT NOT NULL,               -- the team page URL
  members_json        TEXT NOT NULL,               -- JSON array of {entity_id?, name, role_title?, profile_url?, slug?}
  members_count       INTEGER NOT NULL DEFAULT 0,
  fetched_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (firm_entity_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_firm_team_snapshots_firm_date
  ON firm_team_snapshots(firm_entity_id, snapshot_date DESC);

CREATE TABLE IF NOT EXISTS partner_movements (
  id                       TEXT PRIMARY KEY,
  person_entity_id         TEXT,                   -- u_entities.id (resolved person), nullable until canonicalized
  person_name_raw          TEXT NOT NULL,          -- exact name as observed
  person_name_normalized   TEXT NOT NULL,          -- lowercase canonical for dedupe
  from_firm_entity_id      TEXT,                   -- nullable for 'joined' moves whose prior firm we don't know
  to_firm_entity_id        TEXT,                   -- nullable for 'left' moves
  from_title               TEXT,
  to_title                 TEXT,
  movement_type            TEXT NOT NULL,          -- joined | left | promoted | title_change
  observed_at              TEXT NOT NULL,          -- snapshot_date of the diff that emitted this row
  source_url               TEXT,                   -- team page that surfaced the move
  corroborated_by_count    INTEGER NOT NULL DEFAULT 0,
  corroboration_sources_json TEXT,                 -- JSON array of {source_kind, url, observed_at}
  status                   TEXT NOT NULL DEFAULT 'provisional', -- provisional | confirmed | rejected
  dedupe_key               TEXT NOT NULL UNIQUE,   -- sha256(person_norm|movement_type|from|to|month_bucket)
  created_at               TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_partner_movements_person_time
  ON partner_movements(person_entity_id, observed_at DESC)
  WHERE person_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partner_movements_from_firm_time
  ON partner_movements(from_firm_entity_id, observed_at DESC)
  WHERE from_firm_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partner_movements_to_firm_time
  ON partner_movements(to_firm_entity_id, observed_at DESC)
  WHERE to_firm_entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partner_movements_status_time
  ON partner_movements(status, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_partner_movements_type_time
  ON partner_movements(movement_type, observed_at DESC);

CREATE TABLE IF NOT EXISTS fund_spinouts (
  id                      TEXT PRIMARY KEY,
  parent_firm_entity_id   TEXT NOT NULL,
  new_firm_entity_id      TEXT,                    -- nullable until the new firm is canonicalized
  new_firm_name           TEXT,
  departing_people_json   TEXT NOT NULL,           -- JSON array of {person_entity_id?, name}
  window_start            TEXT NOT NULL,           -- earliest 'left' observed_at
  window_end              TEXT NOT NULL,           -- latest 'left' observed_at
  source_urls_json        TEXT,                    -- JSON array of corroborating URLs
  status                  TEXT NOT NULL DEFAULT 'provisional', -- provisional | confirmed | rejected
  dedupe_key              TEXT NOT NULL UNIQUE,    -- sha256(parent|sorted(person_norms))
  created_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_fund_spinouts_parent
  ON fund_spinouts(parent_firm_entity_id, window_end DESC);

CREATE INDEX IF NOT EXISTS idx_fund_spinouts_new
  ON fund_spinouts(new_firm_entity_id)
  WHERE new_firm_entity_id IS NOT NULL;
