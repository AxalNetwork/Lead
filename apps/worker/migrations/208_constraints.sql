-- Task #4: integrity triggers. D1 doesn't support FK enforcement across
-- arbitrary cross-table references after the fact, so we use triggers to
-- enforce the invariants we care about. These are best-effort: dual-write
-- catches violations before insert, but the triggers are the last line
-- of defence.

-- 1) merged_into_entity_id NOT NULL implies status='merged'.
CREATE TRIGGER IF NOT EXISTS trg_entities_merged_status
  BEFORE UPDATE OF merged_into_entity_id, status ON u_entities
  FOR EACH ROW
  WHEN NEW.merged_into_entity_id IS NOT NULL AND NEW.status <> 'merged'
BEGIN
  SELECT RAISE(ABORT, 'merged_into_entity_id requires status=merged');
END;

CREATE TRIGGER IF NOT EXISTS trg_entities_merged_status_ins
  BEFORE INSERT ON u_entities
  FOR EACH ROW
  WHEN NEW.merged_into_entity_id IS NOT NULL AND NEW.status <> 'merged'
BEGIN
  SELECT RAISE(ABORT, 'merged_into_entity_id requires status=merged');
END;

-- 2) Cascade soft-delete: setting an entity to merged/soft_deleted flips
--    is_current=0 on every fact of that entity so list queries naturally
--    exclude it.
CREATE TRIGGER IF NOT EXISTS trg_entities_status_cascade
  AFTER UPDATE OF status ON u_entities
  FOR EACH ROW
  WHEN NEW.status IN ('merged', 'soft_deleted') AND OLD.status NOT IN ('merged', 'soft_deleted')
BEGIN
  UPDATE facts SET is_current = 0 WHERE entity_id = NEW.id AND is_current = 1;
END;

-- 3) When a new fact is inserted with is_current=1 for the same
--    (entity, predicate, source), supersede the prior current fact.
CREATE TRIGGER IF NOT EXISTS trg_facts_supersede
  AFTER INSERT ON facts
  FOR EACH ROW
  WHEN NEW.is_current = 1
BEGIN
  UPDATE facts
    SET is_current = 0
    WHERE entity_id = NEW.entity_id
      AND predicate = NEW.predicate
      AND COALESCE(source, '') = COALESCE(NEW.source, '')
      AND id <> NEW.id
      AND is_current = 1;
END;
