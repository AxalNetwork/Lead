-- Task #3 round-5: tighten uniqueness on identity-resolution writes.
--
-- 1. identity_handles: add a partial unique index on (platform, handle)
--    restricted to is_active = 1 so the same external handle cannot be
--    attached to two different entities simultaneously. We keep the
--    existing UNIQUE(entity_id, platform, handle) so the ON CONFLICT
--    upsert path in resolve.ts/routes still works for same-entity
--    re-attach. Demoted rows (is_active = 0) are exempt, which preserves
--    the audit trail of reverify-demoted handles.
--
-- 2. email_hashes: spec calls for one hash per (entity_id, algorithm).
--    The original UNIQUE(entity_id, algorithm, hash_hex) would have let
--    a single entity accumulate multiple sha256 hashes — weakening the
--    deterministic behavior the resolver assumes. SQLite cannot drop a
--    UNIQUE constraint without rebuilding the table, so we recreate it.

CREATE UNIQUE INDEX IF NOT EXISTS idx_ih_active_global_ph
  ON identity_handles(platform, handle) WHERE is_active = 1;

CREATE TABLE IF NOT EXISTS email_hashes__new (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL,
  algorithm       TEXT NOT NULL
                  CHECK (algorithm IN ('sha256','md5','sha1','gravatar')),
  hash_hex        TEXT NOT NULL,
  email_lowercase TEXT,
  source          TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(entity_id, algorithm)
);
INSERT OR IGNORE INTO email_hashes__new
  (id, entity_id, algorithm, hash_hex, email_lowercase, source, created_at)
  SELECT id, entity_id, algorithm, hash_hex, email_lowercase, source, created_at
    FROM email_hashes;
DROP TABLE email_hashes;
ALTER TABLE email_hashes__new RENAME TO email_hashes;
CREATE INDEX IF NOT EXISTS idx_eh_entity ON email_hashes(entity_id);
CREATE INDEX IF NOT EXISTS idx_eh_hash   ON email_hashes(algorithm, hash_hex);
