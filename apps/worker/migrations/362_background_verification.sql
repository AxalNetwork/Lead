-- Task #14: Background Verification + Reference Network.
--
-- Migration numbering: spec said 358 but 358/359/360/361 are taken
-- (Task #4 alert kinds / Task #5 cap tables / Task #9 valuation /
-- Task #13 documents). This lands at 362 — the next free slot.
-- Documented in replit.md as the canonical bump.
--
-- Two append-only tables:
--   1. verification_findings — one immutable row per
--      (person_entity_id, claim_predicate, claim_value_hash, runner_version).
--      Re-runs that change `status` write a new row and mark the prior one
--      `superseded=1`; the latest is_current=1 row wins for read joins.
--      Mirrors the Task #1 supersedes-chain pattern.
--
--   2. reference_candidates — one row per (subject_entity_id, ref_entity_id,
--      relationship_kind). Idempotent upsert; re-running the builder
--      refreshes confidence / time-overlap / reasoning in place.
--
-- All derived business facts (e.g. person.education.verified,
-- person.prior_startup.outcome) flow through `insertFact` per the Task #1
-- canonical write contract — this migration does NOT touch the facts
-- table directly.

CREATE TABLE IF NOT EXISTS verification_findings (
  id                  TEXT PRIMARY KEY,
  person_entity_id    TEXT NOT NULL,
  claim_predicate     TEXT NOT NULL,        -- 'person.education' | 'person.career_entry' | …
  claim_value_hash    TEXT NOT NULL,        -- sha256 of the canonical claim payload
  claim_summary       TEXT,                 -- short human-readable form of the claim
  verifier_name       TEXT NOT NULL,        -- 'education' | 'employment' | …
  verifier_version    TEXT NOT NULL,        -- semver of the verifier module
  status              TEXT NOT NULL,        -- 'confirmed'|'contradicted'|'unverifiable'|'skipped'
  confidence          REAL NOT NULL DEFAULT 0.5,
  evidence_snippet    TEXT,                 -- ≤500 chars supporting text
  evidence_url        TEXT,                 -- canonical source URL
  sources_json        TEXT,                 -- ["https://…", …] additional corroborating URLs
  reason              TEXT,                 -- short machine-readable reason (e.g. 'no_directory_match')
  is_current          INTEGER NOT NULL DEFAULT 1,
  superseded_by       TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_vf_person          ON verification_findings(person_entity_id, is_current);
CREATE INDEX IF NOT EXISTS idx_vf_person_claim    ON verification_findings(person_entity_id, claim_predicate, claim_value_hash);
CREATE INDEX IF NOT EXISTS idx_vf_status          ON verification_findings(status) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS reference_candidates (
  id                  TEXT PRIMARY KEY,
  subject_entity_id   TEXT NOT NULL,        -- the person being researched
  ref_entity_id       TEXT,                 -- the candidate reference (nullable when unresolved)
  ref_display_name    TEXT NOT NULL,        -- always populated for UI
  relationship_kind   TEXT NOT NULL,        -- co_founder | early_employee | board_peer | co_author | co_panelist | batch_cohort
  shared_context      TEXT,                 -- 'Acme Inc.' | 'Stanford CS' | 'Y Combinator W19' | 'NeurIPS 2022'
  time_overlap_months INTEGER,              -- derived overlap window
  confidence          REAL NOT NULL DEFAULT 0.5,
  reasoning           TEXT,                 -- short rationale string ('co-founders of Acme Inc 2014-2019')
  evidence_url        TEXT,
  builder_version     TEXT NOT NULL,
  refreshed_at        TEXT NOT NULL DEFAULT (datetime('now')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Table-level UNIQUE cannot contain expressions in SQLite/D1; the
-- conflict target is a partial expression index that the persist
-- layer's ON CONFLICT clause matches exactly.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rc_natural
  ON reference_candidates(subject_entity_id, ref_display_name, relationship_kind, COALESCE(shared_context,''));
CREATE INDEX IF NOT EXISTS idx_rc_subject         ON reference_candidates(subject_entity_id, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_rc_subject_kind    ON reference_candidates(subject_entity_id, relationship_kind);
CREATE INDEX IF NOT EXISTS idx_rc_ref             ON reference_candidates(ref_entity_id) WHERE ref_entity_id IS NOT NULL;

-- Track viewed-at + verified-at so the nightly sweep can pick the stalest
-- person whose Verification tab has been viewed in the last 30 days
-- (per the Task #14 sweep criterion).
CREATE TABLE IF NOT EXISTS person_verification_state (
  entity_id           TEXT PRIMARY KEY,
  last_verified_at    TEXT,
  last_viewed_at      TEXT,
  claims_hash         TEXT,                 -- sha256 of sorted claim ids — changes ⇒ re-verify
  updated_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pvs_stale          ON person_verification_state(last_verified_at);
CREATE INDEX IF NOT EXISTS idx_pvs_viewed         ON person_verification_state(last_viewed_at DESC);
