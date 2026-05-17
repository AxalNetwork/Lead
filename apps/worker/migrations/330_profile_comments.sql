-- Task #6: per-entity operator notes shown in the dossier right rail.
--
-- Tiny additive table (no FKs into u_entities — entity_id is just a TEXT
-- reference so the table is safe to deploy ahead of any merge-rewrite).
-- Single-tenant operator workspace, so author_email is just stored verbatim
-- from c.var.email; no separate users table.

CREATE TABLE IF NOT EXISTS profile_comments (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  author_email  TEXT NOT NULL,
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_profile_comments_entity
  ON profile_comments(entity_id, created_at DESC)
  WHERE deleted_at IS NULL;
