-- Slot 120 originally held the relationship graph schema while 110 was
-- occupied by 110_firms_ui.sql. Schema has since been moved into
-- 110_relationships.sql to match the Task #21 spec contract; this file
-- remains as a no-op so already-applied environments don't see a
-- migration deletion. The CREATE TABLE statements in 110 are guarded
-- with IF NOT EXISTS, so the order is now harmless.
SELECT 1;
