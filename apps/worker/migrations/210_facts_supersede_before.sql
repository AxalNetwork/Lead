-- Task #4 fix: the AFTER INSERT supersede trigger in 208 races the
-- partial UNIQUE index uq_facts_current_per_pred added in 209. The
-- insert tries to add a second is_current=1 row before the trigger
-- gets a chance to flip the previous current row off, which fails the
-- unique constraint.
--
-- Fix: replace the AFTER trigger with a BEFORE INSERT trigger that
-- supersedes the prior current row *first*, so by the time the new
-- row is inserted there is exactly one current row per
-- (entity_id, predicate, source).

DROP TRIGGER IF EXISTS trg_facts_supersede;

CREATE TRIGGER IF NOT EXISTS trg_facts_supersede
  BEFORE INSERT ON facts
  FOR EACH ROW
  WHEN NEW.is_current = 1
BEGIN
  UPDATE facts
    SET is_current = 0
    WHERE entity_id = NEW.entity_id
      AND predicate = NEW.predicate
      AND IFNULL(source, '') = IFNULL(NEW.source, '')
      AND is_current = 1;
END;
