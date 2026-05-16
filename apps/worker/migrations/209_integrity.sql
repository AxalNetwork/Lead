-- Task #4: extra integrity controls beyond 208.
-- D1/SQLite has no deferred FK across tables we want to keep loose, so we
-- use triggers + a partial unique index for the cases that matter most.

-- 1) Existence check: facts/channels/entity_tags/entity_roles/rel_edges/
--    entity_summary rows must reference an existing u_entities.id. We
--    enforce on INSERT only (UPDATE-of-entity_id is rare and the merge
--    code path already validates the target).
CREATE TRIGGER IF NOT EXISTS trg_facts_entity_fk
  BEFORE INSERT ON facts
  FOR EACH ROW
  WHEN (SELECT 1 FROM u_entities WHERE id = NEW.entity_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'facts.entity_id does not reference u_entities.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_channels_entity_fk
  BEFORE INSERT ON channels
  FOR EACH ROW
  WHEN (SELECT 1 FROM u_entities WHERE id = NEW.entity_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'channels.entity_id does not reference u_entities.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_tags_entity_fk
  BEFORE INSERT ON entity_tags
  FOR EACH ROW
  WHEN (SELECT 1 FROM u_entities WHERE id = NEW.entity_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'entity_tags.entity_id does not reference u_entities.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_roles_entity_fk
  BEFORE INSERT ON entity_roles
  FOR EACH ROW
  WHEN (SELECT 1 FROM u_entities WHERE id = NEW.entity_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'entity_roles.entity_id does not reference u_entities.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_rel_edges_src_fk
  BEFORE INSERT ON rel_edges
  FOR EACH ROW
  WHEN (SELECT 1 FROM u_entities WHERE id = NEW.src_entity_id) IS NULL
     OR (SELECT 1 FROM u_entities WHERE id = NEW.dst_entity_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'rel_edges endpoints must reference u_entities.id');
END;

CREATE TRIGGER IF NOT EXISTS trg_summary_entity_fk
  BEFORE INSERT ON entity_summary
  FOR EACH ROW
  WHEN (SELECT 1 FROM u_entities WHERE id = NEW.entity_id) IS NULL
BEGIN
  SELECT RAISE(ABORT, 'entity_summary.entity_id does not reference u_entities.id');
END;

-- 2) Channel canonical normalization enforcement: canonical must be
--    non-empty and lowercased for the kinds that have a stable casing
--    rule (email/linkedin/twitter/github/website/other).
CREATE TRIGGER IF NOT EXISTS trg_channels_canonical_nonempty
  BEFORE INSERT ON channels
  FOR EACH ROW
  WHEN NEW.canonical IS NULL OR TRIM(NEW.canonical) = ''
BEGIN
  SELECT RAISE(ABORT, 'channels.canonical must be non-empty');
END;

CREATE TRIGGER IF NOT EXISTS trg_channels_canonical_lower
  BEFORE INSERT ON channels
  FOR EACH ROW
  WHEN NEW.kind IN ('email','linkedin','twitter','github','website','other')
   AND NEW.canonical <> LOWER(NEW.canonical)
BEGIN
  SELECT RAISE(ABORT, 'channels.canonical must be lowercased for this kind');
END;

-- 3) Enforce facts is_current uniqueness per (entity_id, predicate, source)
--    via a partial unique index. The 208 supersede trigger keeps writes
--    correct; this index is the structural guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS uq_facts_current_per_pred
  ON facts(entity_id, predicate, IFNULL(source,''))
  WHERE is_current = 1;
