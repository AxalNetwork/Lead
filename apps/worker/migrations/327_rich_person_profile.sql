-- Task #4: Rich person profile schema.
--
-- 13 structured projection tables for the Profile tabs (Identity / Career /
-- Education / Family / Preferences / Interests / Lifestyle / Travel /
-- Conferences / Goals / Conversation hooks / Appreciation signals).
--
-- Every row is also mirrored into `facts` by EntityService write helpers
-- (apps/worker/src/entities/profile.ts) so the unified facts table remains
-- the cross-entity query surface (search, timeline, alerts, agent).
--
-- All tables key on `entity_id` (logical FK to u_entities.id; no SQL FK
-- because D1 tolerates dangling refs better and the merge path rewrites
-- IDs in-place). Natural keys ensure write-twice idempotency.
--
-- JSON-column shapes are documented per table header AND mirrored in TS
-- in apps/worker/src/entities/profile-shapes.ts. Helpers serialize
-- through those typed shapes, never raw JSON.stringify(unknown).

-- ===========================================================================
-- 1. person_identity  -- single row per entity. Operator-asserted columns
--    are allowed without a source_url (the exception called out in the
--    task's public-signal-only constraint). All other writes require one.
--
-- pronouns_json shape: { subject:string, object:string, possessive:string }
-- languages_json shape: [{ code:string (ISO 639-1), proficiency?:"native"|"fluent"|"working"|"basic" }]
-- ===========================================================================
CREATE TABLE IF NOT EXISTS person_identity (
  entity_id        TEXT PRIMARY KEY,
  full_name        TEXT,
  preferred_name   TEXT,
  pronouns_json    TEXT,
  birth_year       INTEGER,
  nationality      TEXT,        -- ISO 3166-1 alpha-2
  languages_json   TEXT,
  timezone         TEXT,        -- IANA tz database name
  location_city    TEXT,
  location_country TEXT,        -- ISO 3166-1 alpha-2
  headshot_url     TEXT,
  source_url       TEXT,        -- nullable: operator-asserted rows have NULL
  is_operator_asserted INTEGER NOT NULL DEFAULT 0,
  confidence       REAL NOT NULL DEFAULT 1.0,
  observed_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ===========================================================================
-- 2. career_history. Natural key (entity_id, organization_entity_id, started_at).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS career_history (
  id                       TEXT PRIMARY KEY,
  entity_id                TEXT NOT NULL,
  organization_entity_id   TEXT,        -- nullable when the org isn't an entity yet
  organization_name        TEXT NOT NULL,
  role_title               TEXT,
  seniority                TEXT,        -- 'ic'|'manager'|'director'|'vp'|'svp'|'cxo'|'founder'|'partner'|'principal'|'analyst'
  department               TEXT,
  started_at               TEXT,        -- ISO date or YYYY-MM
  ended_at                 TEXT,
  is_current               INTEGER NOT NULL DEFAULT 0,
  summary                  TEXT,
  source_url               TEXT NOT NULL,
  confidence               REAL NOT NULL DEFAULT 1.0,
  observed_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Expression index over COALESCE(...) — SQLite treats NULL as distinct in
-- UNIQUE, so we coerce nullable key components to '' for idempotent upsert.
-- Helpers issue ON CONFLICT against the exact same expression list.
CREATE UNIQUE INDEX IF NOT EXISTS uq_career_natural
  ON career_history(entity_id, COALESCE(organization_entity_id,''), organization_name, COALESCE(started_at,''));
CREATE INDEX IF NOT EXISTS idx_career_entity         ON career_history(entity_id);
CREATE INDEX IF NOT EXISTS idx_career_entity_current ON career_history(entity_id, is_current);
CREATE INDEX IF NOT EXISTS idx_career_org            ON career_history(organization_entity_id) WHERE organization_entity_id IS NOT NULL;

-- ===========================================================================
-- 3. board_seats. Natural key (entity_id, organization_name, started_at).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS board_seats (
  id                       TEXT PRIMARY KEY,
  entity_id                TEXT NOT NULL,
  organization_entity_id   TEXT,
  organization_name        TEXT NOT NULL,
  role                     TEXT,        -- 'chair'|'director'|'observer'|'advisor'
  is_independent           INTEGER NOT NULL DEFAULT 0,
  committee                TEXT,        -- 'audit'|'comp'|'nom'|'risk' etc.
  started_at               TEXT,
  ended_at                 TEXT,
  source_url               TEXT NOT NULL,
  confidence               REAL NOT NULL DEFAULT 1.0,
  observed_at              TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at               TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_board_natural
  ON board_seats(entity_id, organization_name, COALESCE(started_at,''));
CREATE INDEX IF NOT EXISTS idx_board_entity      ON board_seats(entity_id);
CREATE INDEX IF NOT EXISTS idx_board_entity_end  ON board_seats(entity_id, ended_at DESC);

-- ===========================================================================
-- 4. education_history. Natural key (entity_id, institution, degree, ended_year).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS education_history (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  institution     TEXT NOT NULL,
  degree          TEXT,         -- 'BA'|'BS'|'MBA'|'MS'|'PhD' etc.
  field           TEXT,
  started_year    INTEGER,
  ended_year      INTEGER,
  honors          TEXT,
  source_url      TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_edu_natural
  ON education_history(entity_id, institution, COALESCE(degree,''), COALESCE(ended_year,0));
CREATE INDEX IF NOT EXISTS idx_edu_entity       ON education_history(entity_id);
CREATE INDEX IF NOT EXISTS idx_edu_entity_year  ON education_history(entity_id, ended_year DESC);

-- ===========================================================================
-- 5. family_ties.
--   is_public=0 rows are operator-private and MUST be excluded from any
--   public-facing API response and from the agent's retrievable context
--   (enforced by the route layer, not this migration).
-- Natural key (entity_id, relation_type, related_name).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS family_ties (
  id                  TEXT PRIMARY KEY,
  entity_id           TEXT NOT NULL,
  relation_type       TEXT NOT NULL,   -- 'spouse'|'partner'|'parent'|'child'|'sibling'|'in_law'|'other'
  related_name        TEXT NOT NULL,
  related_entity_id   TEXT,
  notes               TEXT,
  is_public           INTEGER NOT NULL DEFAULT 0,
  source_url          TEXT NOT NULL,
  confidence          REAL NOT NULL DEFAULT 1.0,
  observed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, relation_type, related_name)
);
CREATE INDEX IF NOT EXISTS idx_family_entity     ON family_ties(entity_id);
CREATE INDEX IF NOT EXISTS idx_family_related    ON family_ties(related_entity_id) WHERE related_entity_id IS NOT NULL;

-- ===========================================================================
-- 6. person_preferences. One row per (entity_id, preference_key). The key
--    namespace mirrors predicate slugs in person.preference.*.
-- value_json shape: { value: string|number|boolean|object, unit?: string }
-- Natural key (entity_id, preference_key).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS person_preferences (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  preference_key  TEXT NOT NULL,    -- e.g. 'coffee_order'|'travel_class'|'gift_dietary'
  value_text      TEXT,
  value_json      TEXT,
  source_url      TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, preference_key)
);
CREATE INDEX IF NOT EXISTS idx_pref_entity      ON person_preferences(entity_id);

-- ===========================================================================
-- 7. person_interests. Natural key (entity_id, interest_category, interest_value).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS person_interests (
  id                  TEXT PRIMARY KEY,
  entity_id           TEXT NOT NULL,
  interest_category   TEXT NOT NULL,   -- 'topic'|'sport'|'team'|'book'|'author'|'podcast'|'music'|'artist'|'film'|'show'|'hobby'|'cause'
  interest_value      TEXT NOT NULL,
  weight              REAL NOT NULL DEFAULT 1.0,
  source_url          TEXT NOT NULL,
  confidence          REAL NOT NULL DEFAULT 1.0,
  observed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, interest_category, interest_value)
);
CREATE INDEX IF NOT EXISTS idx_interest_entity         ON person_interests(entity_id);
CREATE INDEX IF NOT EXISTS idx_interest_entity_cat     ON person_interests(entity_id, interest_category);

-- ===========================================================================
-- 8. lifestyle_signals. Open vocabulary: signal_key drawn from
--    person.lifestyle.* predicate registry slugs.
-- value_json shape: { detail?: string, frequency?: 'daily'|'weekly'|'monthly'|'occasional' }
-- Natural key (entity_id, signal_key) — last-write-wins on the structured
-- row. Cadence history is preserved in `facts` (one row per observation
-- date via insertFact's content-addressable hash).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS lifestyle_signals (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  signal_key      TEXT NOT NULL,   -- 'runs'|'cycles'|'surfs'|'skis'|'golfs'|'yoga'|'meditates'|'cooks'|'collects'|'pet'|'marathon'|'ironman'
  value_text      TEXT,
  value_json      TEXT,
  source_url      TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, signal_key)
);
CREATE INDEX IF NOT EXISTS idx_lifestyle_entity         ON lifestyle_signals(entity_id);
CREATE INDEX IF NOT EXISTS idx_lifestyle_entity_obs     ON lifestyle_signals(entity_id, observed_at DESC);

-- ===========================================================================
-- 9. travel_patterns. Natural key (entity_id, pattern_kind, place).
-- pattern_kind: 'frequent_city'|'home_base'|'recent_trip'|'upcoming_trip'|'airport_hub'
-- ===========================================================================
CREATE TABLE IF NOT EXISTS travel_patterns (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  pattern_kind    TEXT NOT NULL,
  place           TEXT NOT NULL,       -- city / IATA code / region label
  country_iso2    TEXT,
  starts_at       TEXT,
  ends_at         TEXT,
  source_url      TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_travel_natural
  ON travel_patterns(entity_id, pattern_kind, place, COALESCE(starts_at,''));
CREATE INDEX IF NOT EXISTS idx_travel_entity        ON travel_patterns(entity_id);
CREATE INDEX IF NOT EXISTS idx_travel_entity_kind   ON travel_patterns(entity_id, pattern_kind);

-- ===========================================================================
-- 10. conference_attendance. Natural key UNIQUE(entity_id, conference_name, year).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS conference_attendance (
  id                  TEXT PRIMARY KEY,
  entity_id           TEXT NOT NULL,
  conference_name     TEXT NOT NULL,
  year                INTEGER NOT NULL,
  role                TEXT,            -- 'speaker'|'attendee'|'organizer'|'sponsor'|'panelist'
  session_topic       TEXT,
  city                TEXT,
  country_iso2        TEXT,
  source_url          TEXT NOT NULL,
  confidence          REAL NOT NULL DEFAULT 1.0,
  observed_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, conference_name, year)
);
CREATE INDEX IF NOT EXISTS idx_conf_entity      ON conference_attendance(entity_id);
CREATE INDEX IF NOT EXISTS idx_conf_entity_yr   ON conference_attendance(entity_id, year DESC);

-- ===========================================================================
-- 11. person_goals. Natural key (entity_id, goal_kind, goal_text).
-- goal_kind: 'short_term'|'long_term'|'hiring'|'fundraising'|'investing_thesis'|'expansion_market'
-- ===========================================================================
CREATE TABLE IF NOT EXISTS person_goals (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  goal_kind       TEXT NOT NULL,
  goal_text       TEXT NOT NULL,
  target_date     TEXT,
  source_url      TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, goal_kind, goal_text)
);
CREATE INDEX IF NOT EXISTS idx_goal_entity      ON person_goals(entity_id);

-- ===========================================================================
-- 12. conversation_hooks. Natural key (entity_id, hook_kind, hook_text).
-- hook_kind: 'recent_news'|'shared_connection'|'shared_school'|'shared_employer'|
--            'shared_interest'|'recent_post'|'life_event'|'opinion_quoted'
-- ===========================================================================
CREATE TABLE IF NOT EXISTS conversation_hooks (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  hook_kind       TEXT NOT NULL,
  hook_text       TEXT NOT NULL,
  related_entity_id TEXT,
  source_url      TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, hook_kind, hook_text)
);
CREATE INDEX IF NOT EXISTS idx_hook_entity          ON conversation_hooks(entity_id);
CREATE INDEX IF NOT EXISTS idx_hook_entity_obs      ON conversation_hooks(entity_id, observed_at DESC);

-- ===========================================================================
-- 13. appreciation_signals. Natural key (entity_id, signal_kind, signal_text).
-- signal_kind: 'compliment_topic'|'gift_idea'|'charity_supported'|
--              'cause_advocated'|'recognition_received'
-- ===========================================================================
CREATE TABLE IF NOT EXISTS appreciation_signals (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  signal_kind     TEXT NOT NULL,
  signal_text     TEXT NOT NULL,
  source_url      TEXT NOT NULL,
  confidence      REAL NOT NULL DEFAULT 1.0,
  observed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, signal_kind, signal_text)
);
CREATE INDEX IF NOT EXISTS idx_appr_entity      ON appreciation_signals(entity_id);
