-- Task #6: clean up the news-articles-as-entities damage.
--
-- Before the page classifier landed (Task #6, src/services/pageClassifier.ts),
-- the URL crawler ran every fetched page through the firm/lead path. News
-- articles from techcrunch / bloomberg / press wires therefore produced
-- u_entities rows whose `display_name` was actually a headline (e.g.
-- "OpenAI's latest model can almost reason like a human", "$50M Series B
-- for FooBar"). They showed up as fake companies on the Accounts /
-- Customers dashboard.
--
-- This migration:
--   1. Soft-deletes any u_entities row whose display_name matches one of
--      the headline heuristics (≥ 8 whitespace tokens AND a strong
--      news-verb / funding-dollar signal). status='soft_deleted' is the
--      canonical "hide from dashboards" state in 200_unified_entities.sql.
--   2. Removes the matching rows from the legacy `firms` and `leads`
--      tables (those still drive a few dashboards via dual-write).
--   3. Logs the count of affected rows into a small audit table so
--      operators can verify the cleanup before any follow-up sweep.
--
-- Matching is intentionally conservative:
--   * length(name) >= 40   (cheap pre-filter)
--   * word count >= 8      (length - length(replace(' ','')) >= 7) —
--     legitimate org names ("Sequoia Capital", "Andreessen Horowitz")
--     are 1–4 tokens and never trigger.
--   * AND at least one HEADLINE signal:
--       - starts with `$` (funding-round headlines)
--       - contains a common news verb in sentence position
--   The earlier draft also matched `LIKE '%: %'` (any colon) — pulled
--   because legitimate org descriptions ("Acme: a software company")
--   would have been false-positives.
--
-- Drift from task spec:
--   - Spec says "remove entities.type='news_article'". The unified
--     entity table is `u_entities` and its kind enum is just
--     person|org (see 200_unified_entities.sql line 19 + model.ts).
--     There is no `type` column and no `news_article` value anywhere
--     in the schema or PREDICATE_REGISTRY, so there is nothing to
--     remove from the constraint set. The new classifier prevents
--     these rows from being created in the first place.
--   - Spec mentioned migration 332 as the next number; 332 and 333
--     were already taken (CSV imports + Task #5 backfill), so this
--     is 334.
--   - Backfill uses soft-delete instead of physical DELETE on
--     u_entities so any FK references (entity_legacy_map, news_entity
--     _mentions, facts) stay valid and the operator can audit.

CREATE TABLE IF NOT EXISTS news_as_entity_cleanup_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  u_entities_soft_deleted INTEGER NOT NULL DEFAULT 0,
  firms_deleted INTEGER NOT NULL DEFAULT 0,
  leads_deleted INTEGER NOT NULL DEFAULT 0,
  notes TEXT
);

-- ---- u_entities: soft-delete headline-shaped display_names. ----
UPDATE u_entities
   SET status = 'soft_deleted',
       updated_at = datetime('now')
 WHERE status = 'active'
   AND display_name IS NOT NULL
   AND length(display_name) >= 40
   AND (length(display_name) - length(replace(display_name, ' ', ''))) >= 7
   AND (
        substr(trim(display_name), 1, 1) = '$'
     OR lower(display_name) LIKE '% announces %'
     OR lower(display_name) LIKE '% raises %'
     OR lower(display_name) LIKE '% launches %'
     OR lower(display_name) LIKE '% acquires %'
     OR lower(display_name) LIKE '% unveils %'
     OR lower(display_name) LIKE '% to acquire %'
     OR lower(display_name) LIKE '% says %'
     OR lower(display_name) LIKE '% reportedly %'
     OR lower(display_name) LIKE '% files for %'
     OR lower(display_name) LIKE '% takes charge %'
     OR lower(display_name) LIKE '% turn to %'
     OR lower(display_name) LIKE '% will ban %'
     OR lower(display_name) LIKE '% jailbreaking %'
     OR lower(display_name) LIKE '% almost died %'
   );

-- ---- firms: physically remove the same shape (legacy table). ----
DELETE FROM firms
 WHERE name IS NOT NULL
   AND length(name) >= 40
   AND (length(name) - length(replace(name, ' ', ''))) >= 7
   AND (
        substr(trim(name), 1, 1) = '$'
     OR lower(name) LIKE '% announces %'
     OR lower(name) LIKE '% raises %'
     OR lower(name) LIKE '% launches %'
     OR lower(name) LIKE '% acquires %'
     OR lower(name) LIKE '% unveils %'
     OR lower(name) LIKE '% to acquire %'
     OR lower(name) LIKE '% says %'
     OR lower(name) LIKE '% reportedly %'
     OR lower(name) LIKE '% files for %'
     OR lower(name) LIKE '% takes charge %'
     OR lower(name) LIKE '% turn to %'
     OR lower(name) LIKE '% will ban %'
     OR lower(name) LIKE '% jailbreaking %'
     OR lower(name) LIKE '% almost died %'
   );

-- ---- leads: same pattern, but match on org since lead.name is the
--      person name and lead.org carries the bogus headline value. ----
DELETE FROM leads
 WHERE org IS NOT NULL
   AND length(org) >= 40
   AND (length(org) - length(replace(org, ' ', ''))) >= 7
   AND (
        substr(trim(org), 1, 1) = '$'
     OR lower(org) LIKE '% announces %'
     OR lower(org) LIKE '% raises %'
     OR lower(org) LIKE '% launches %'
     OR lower(org) LIKE '% acquires %'
     OR lower(org) LIKE '% unveils %'
     OR lower(org) LIKE '% to acquire %'
     OR lower(org) LIKE '% says %'
     OR lower(org) LIKE '% reportedly %'
     OR lower(org) LIKE '% files for %'
     OR lower(org) LIKE '% takes charge %'
     OR lower(org) LIKE '% turn to %'
     OR lower(org) LIKE '% will ban %'
     OR lower(org) LIKE '% jailbreaking %'
     OR lower(org) LIKE '% almost died %'
   );

-- ---- Audit row: count of rows currently matching the soft-deleted shape. ----
INSERT INTO news_as_entity_cleanup_log (u_entities_soft_deleted, firms_deleted, leads_deleted, notes)
SELECT
  (SELECT COUNT(*) FROM u_entities
    WHERE status='soft_deleted'
      AND display_name IS NOT NULL
      AND length(display_name) >= 40
      AND (length(display_name) - length(replace(display_name, ' ', ''))) >= 7
      AND (substr(trim(display_name),1,1)='$'
        OR lower(display_name) LIKE '% announces %'
        OR lower(display_name) LIKE '% raises %'
        OR lower(display_name) LIKE '% launches %'
        OR lower(display_name) LIKE '% acquires %')),
  0, 0,
  'migration_334_initial_run';
