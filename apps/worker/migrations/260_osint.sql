-- Task #3 (this task): Cross-platform identity resolution & OSINT pivots.
--
-- Schema:
--   identity_handles      — verified or pending handles per entity per platform.
--   handle_candidates     — review queue for non-auto-link hits.
--   avatar_phash          — pHash/dHash fingerprints for cross-platform avatar match.
--   email_hashes          — per-entity email hashes (sha256/md5/sha1) + optional plaintext.
--   osint_negative_cache  — 30-day miss cache (writes also land in KV).
--   stylometric_vectors   — 32-feature writing-style vectors per (entity, platform).
--
-- All `entity_id` columns reference `u_entities(id)` logically; no FK because
-- D1 tolerates dangling refs better and the upstream entity-merge path
-- rewrites IDs in-place. Indexed on entity / platform / (platform, handle).

CREATE TABLE IF NOT EXISTS identity_handles (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT NOT NULL,
  platform          TEXT NOT NULL,     -- enum lives in src/osint/platforms.ts
  handle            TEXT NOT NULL,
  url               TEXT,
  link_method       TEXT NOT NULL
                    CHECK (link_method IN (
                      'manual','keybase','well_known','crypto_ens','crypto_lens',
                      'crypto_farcaster','rel_me','same_as','bio_url','gravatar',
                      'hackernews','reddit','username','avatar_phash','stylometric',
                      'mutual_followers','reverify'
                    )),
  link_confidence   REAL NOT NULL DEFAULT 0,
  evidence_json     TEXT,              -- per-method evidence object
  is_active         INTEGER NOT NULL DEFAULT 1,
  last_verified_at  TEXT NOT NULL DEFAULT (datetime('now')),
  demoted_reason    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, platform, handle)
);
CREATE INDEX IF NOT EXISTS idx_ih_entity     ON identity_handles(entity_id);
CREATE INDEX IF NOT EXISTS idx_ih_platform   ON identity_handles(platform);
CREATE INDEX IF NOT EXISTS idx_ih_ph         ON identity_handles(platform, handle);
CREATE INDEX IF NOT EXISTS idx_ih_active     ON identity_handles(is_active, last_verified_at);

CREATE TABLE IF NOT EXISTS handle_candidates (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT NOT NULL,
  platform          TEXT NOT NULL,
  handle            TEXT NOT NULL,
  url               TEXT,
  link_method       TEXT NOT NULL,
  link_confidence   REAL NOT NULL DEFAULT 0,
  evidence_json     TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','accepted','rejected','needs_more')),
  reviewer_email    TEXT,
  reviewed_at       TEXT,
  reviewer_notes    TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(platform, handle, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_hc_entity   ON handle_candidates(entity_id);
CREATE INDEX IF NOT EXISTS idx_hc_status   ON handle_candidates(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hc_platform ON handle_candidates(platform);

CREATE TABLE IF NOT EXISTS avatar_phash (
  id                TEXT PRIMARY KEY,
  entity_id         TEXT,
  platform          TEXT,
  handle            TEXT,
  source_url        TEXT NOT NULL,
  phash_hex         TEXT NOT NULL,     -- 16 hex chars = 64 bits
  dhash_hex         TEXT,
  width             INTEGER,
  height            INTEGER,
  is_default_avatar INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
-- Hamming-prefix scan: range-query on the leading 4 hex (16 bits) is good
-- enough for a coarse filter on a small dataset; full hamming computed in TS.
CREATE INDEX IF NOT EXISTS idx_ap_phash_prefix ON avatar_phash(substr(phash_hex,1,4));
CREATE INDEX IF NOT EXISTS idx_ap_entity       ON avatar_phash(entity_id);
CREATE INDEX IF NOT EXISTS idx_ap_ph           ON avatar_phash(platform, handle);

CREATE TABLE IF NOT EXISTS email_hashes (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  algorithm       TEXT NOT NULL
                  CHECK (algorithm IN ('sha256','md5','sha1','gravatar')),
  hash_hex        TEXT NOT NULL,
  email_lowercase TEXT,                -- ONLY when source was already public plaintext
  source          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, algorithm, hash_hex)
);
CREATE INDEX IF NOT EXISTS idx_eh_entity ON email_hashes(entity_id);
CREATE INDEX IF NOT EXISTS idx_eh_hash   ON email_hashes(algorithm, hash_hex);

CREATE TABLE IF NOT EXISTS osint_negative_cache (
  entity_id     TEXT NOT NULL,
  platform      TEXT NOT NULL,
  handle_probe  TEXT NOT NULL,
  checked_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ttl_seconds   INTEGER NOT NULL DEFAULT 2592000,
  reason        TEXT,
  PRIMARY KEY (entity_id, platform, handle_probe)
);
CREATE INDEX IF NOT EXISTS idx_onc_checked ON osint_negative_cache(checked_at);

CREATE TABLE IF NOT EXISTS stylometric_vectors (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  source_platform TEXT NOT NULL,
  source_handle   TEXT,
  vector_json     TEXT NOT NULL,       -- JSON array of 32 floats
  features_json   TEXT,                -- raw counts/stats for debug
  word_count      INTEGER NOT NULL DEFAULT 0,
  computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, source_platform, source_handle)
);
CREATE INDEX IF NOT EXISTS idx_sv_entity ON stylometric_vectors(entity_id);

-- Per-entity tracking for re-runs + coverage. Lives on u_entities via a
-- lightweight kv table to avoid schema churn against the entity table.
CREATE TABLE IF NOT EXISTS osint_entity_state (
  entity_id          TEXT PRIMARY KEY,
  last_osint_run_at  TEXT,
  last_reverify_at   TEXT,
  pivots_log_json    TEXT,
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
