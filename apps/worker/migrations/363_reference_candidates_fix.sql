-- Task #14 hotfix: repair reference_candidates natural-key index for DBs
-- that already applied 362 with the expression-indexed
-- COALESCE(shared_context,'') unique index. SQLite UPSERT conflict targets
-- cannot reference an expression-indexed column, so the persist layer's
-- ON CONFLICT clause was silently failing at runtime (caught + logged).
--
-- Steps:
--   1. Backfill any NULL shared_context → '' so the plain-column UNIQUE
--      treats prior rows correctly.
--   2. Drop the old expression-based index.
--   3. Recreate UNIQUE on plain columns (matches new 362).
UPDATE reference_candidates SET shared_context = '' WHERE shared_context IS NULL;
DROP INDEX IF EXISTS uq_rc_natural;
CREATE UNIQUE INDEX IF NOT EXISTS uq_rc_natural
  ON reference_candidates(subject_entity_id, ref_display_name, relationship_kind, shared_context);
