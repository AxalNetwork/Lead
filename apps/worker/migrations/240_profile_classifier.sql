-- Task #3: Profile-type classifier, political-influence & ideology profiler.
--
-- Adds four tables that hang off u_entities:
--   * entity_profile_axes   — per-entity classification + ideology + influence
--   * political_donations   — FEC / OpenSecrets / Elections-Canada style rows
--   * government_appointments — current + historical roles in govt / public office
--   * entity_evidence_quotes — verbatim quotes backing every classification cell
--
-- All AI-derived values carry a `confidence` (0..1) and `evidence_count`. The
-- ideology axes are NULLABLE — we never silently default to 0 (centrist) when
-- there is no evidence. Manual operator overrides bypass AI and never get
-- written back over until an operator clears them.

-- ------------------------------------------------------- entity_profile_axes
CREATE TABLE IF NOT EXISTS entity_profile_axes (
  entity_id              TEXT PRIMARY KEY REFERENCES u_entities(id) ON DELETE CASCADE,

  -- Profile-type weights (sum ~1.0): politician/founder/investor/executive/
  -- academic/journalist/activist/celebrity/lawyer/lobbyist/government_official/
  -- philanthropist/board_director/operator/influencer/other. Stored as JSON
  -- {type: weight}. Top type derivable client-side; cached in `primary_type`.
  type_weights_json      TEXT,
  primary_type           TEXT,
  primary_type_conf      REAL,

  -- Ideology axes — each is NULL when no evidence exists.
  -- left_right:    -1 (far left)  ..  +1 (far right)
  -- libertarian_authoritarian: -1 (libertarian) .. +1 (authoritarian)
  -- progressive_conservative:  -1 (progressive) .. +1 (conservative)
  -- globalist_nationalist:     -1 (globalist)   .. +1 (nationalist)
  -- secular_religious:         -1 (secular)     .. +1 (religious)
  left_right             REAL,
  lib_auth               REAL,
  prog_cons              REAL,
  glob_nat               REAL,
  sec_rel                REAL,
  ideology_conf          REAL,            -- aggregate confidence (0..1)

  -- Derived influence axes (computed, not AI):
  network_centrality     REAL,            -- 0..1 (degree-ish on rel_edges)
  media_influence        REAL,            -- 0..1 (Σ mentions × reputability)
  capital_influence      REAL,            -- 0..1 (log invest_amount + AUM)
  political_influence    REAL,            -- 0..1 (appts × seniority + PEP)

  -- Interest vectors (JSON arrays of {label, weight, source}).
  interests_json         TEXT,            -- causes / policy areas
  hobbies_json           TEXT,            -- non-political interests
  causes_json            TEXT,            -- charitable / activist causes

  -- AI-generated personality / public-persona summary (cached).
  summary_text           TEXT,
  summary_evidence_hash  TEXT,            -- sha256 of evidence corpus → cache key

  -- Flags
  is_pep                 INTEGER NOT NULL DEFAULT 0, -- Politically Exposed Person
  is_government_official INTEGER NOT NULL DEFAULT 0,
  is_lobbyist            INTEGER NOT NULL DEFAULT 0,

  -- Bookkeeping
  evidence_count         INTEGER NOT NULL DEFAULT 0,
  manual_override_json   TEXT,           -- operator-fixed fields ({field: {value, by, at, note}})
  classifier_version     TEXT,           -- e.g. "v1.0-llama3.1-8b"
  classified_at          TEXT,
  refreshed_at           TEXT,
  created_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at             TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_epa_primary_type        ON entity_profile_axes(primary_type);
CREATE INDEX IF NOT EXISTS idx_epa_is_pep              ON entity_profile_axes(is_pep) WHERE is_pep = 1;
CREATE INDEX IF NOT EXISTS idx_epa_is_govt             ON entity_profile_axes(is_government_official) WHERE is_government_official = 1;
CREATE INDEX IF NOT EXISTS idx_epa_pol_influence       ON entity_profile_axes(political_influence DESC);
CREATE INDEX IF NOT EXISTS idx_epa_media_influence     ON entity_profile_axes(media_influence DESC);
CREATE INDEX IF NOT EXISTS idx_epa_refreshed_at        ON entity_profile_axes(refreshed_at);
CREATE INDEX IF NOT EXISTS idx_epa_left_right          ON entity_profile_axes(left_right) WHERE left_right IS NOT NULL;

-- ------------------------------------------------------- political_donations
CREATE TABLE IF NOT EXISTS political_donations (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT NOT NULL REFERENCES u_entities(id) ON DELETE CASCADE,
  donor_name        TEXT,                -- raw donor name as filed
  recipient_name    TEXT NOT NULL,       -- candidate / committee / PAC
  recipient_party   TEXT,                -- democrat / republican / liberal / etc.
  recipient_kind    TEXT,                -- candidate | pac | super_pac | party_cmte | 527 | ballot
  amount_usd        REAL,
  cycle             INTEGER,             -- election cycle year
  occurred_at       TEXT,                -- ISO date
  jurisdiction      TEXT,                -- US-federal | US-CA | UK | CA-federal | …
  source            TEXT NOT NULL,       -- fec | opensecrets | elections-ca | uk-ec | manual
  source_url        TEXT,
  raw_json          TEXT,
  created_at        TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_pd_entity     ON political_donations(entity_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_pd_party      ON political_donations(recipient_party);
CREATE INDEX IF NOT EXISTS idx_pd_cycle      ON political_donations(cycle);
CREATE UNIQUE INDEX IF NOT EXISTS uq_pd_dedupe
  ON political_donations(entity_id, source, recipient_name, occurred_at, amount_usd);

-- --------------------------------------------------- government_appointments
CREATE TABLE IF NOT EXISTS government_appointments (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL REFERENCES u_entities(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,         -- "Senator", "Minister of Finance", "Town Councillor"
  body            TEXT,                  -- "U.S. Senate", "House of Commons", …
  jurisdiction    TEXT,                  -- US-federal | US-CA | UK | CA-QC | …
  party           TEXT,
  seniority       INTEGER,               -- 1=local … 5=head-of-state (rough rank)
  start_date      TEXT,
  end_date        TEXT,                  -- NULL ⇒ current
  is_current      INTEGER NOT NULL DEFAULT 0,
  source          TEXT NOT NULL,         -- wikidata | propublica | parliament-uk | openparliament-ca | manual
  source_url      TEXT,
  raw_json        TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ga_entity        ON government_appointments(entity_id, is_current DESC);
CREATE INDEX IF NOT EXISTS idx_ga_current       ON government_appointments(is_current, jurisdiction) WHERE is_current = 1;
CREATE INDEX IF NOT EXISTS idx_ga_jurisdiction  ON government_appointments(jurisdiction);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ga_dedupe
  ON government_appointments(entity_id, source, title, IFNULL(start_date, ''));

-- --------------------------------------------------- entity_evidence_quotes
-- Verbatim quotes backing every classification cell. axis examples:
--   "type:politician", "ideology:left_right", "interest:climate",
--   "appointment:senator", "donation:republican_party"
CREATE TABLE IF NOT EXISTS entity_evidence_quotes (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL REFERENCES u_entities(id) ON DELETE CASCADE,
  axis            TEXT NOT NULL,
  score           REAL,                   -- signed contribution to the axis (-1..+1) when applicable
  quote           TEXT NOT NULL,          -- max 600 chars
  source_kind     TEXT NOT NULL,          -- news | wikidata | fec | propublica | manual | other
  source_url      TEXT,
  news_item_id    TEXT,                   -- nullable FK to news_items
  observed_at     TEXT,
  created_at      TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_eeq_entity_axis ON entity_evidence_quotes(entity_id, axis);
CREATE INDEX IF NOT EXISTS idx_eeq_axis        ON entity_evidence_quotes(axis);
