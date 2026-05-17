-- Task #5: backfill names that were corrupted by the headerless-CSV
-- mis-mapping (Type/Kind column written into firms.name / leads.name /
-- u_entities.display_name).
--
-- The CSV importer previously assumed row 0 was always headers, which
-- caused the operator's `VC_PE - List of investors….csv` (no header row)
-- to surface rows like name='VC', name='Nonprofit, Training Program',
-- name='VC, Fellows Program' on the Investors dashboard.
--
-- This migration:
--   1. Enqueues enrichment jobs for every corrupted row that has a
--      usable canonical domain (BEFORE the rewrite, so the WHERE
--      clause sees the type-string and only enqueues rows actually
--      being remediated — NOT legitimate rows whose name happens to
--      equal `Sequoia` on `sequoia.com`).
--   2. Rewrites name / display_name from the canonical apex-domain
--      brand token. Only runs when the source column is a clean
--      lower-case host (matches GLOB `*.*` with no `/`, `:`, space,
--      or `@`). Anything else is left alone.
--   3. Is idempotent: after the rewrite the rows no longer match the
--      type-string WHERE clause, so re-running is a no-op. The
--      INSERT INTO jobs also has a NOT EXISTS dedupe against any
--      prior `task5_name_backfill` row.
--
-- Drift from task spec:
--   - Spec referenced `entities.name`; the unified entity table is
--     `u_entities` with column `display_name`.
--   - Spec asked the migration to "enqueue an enrich_entity job". No
--     such JobKind exists (src/types.ts); we use `firm_team_crawl`
--     which is the nearest equivalent (re-crawls firm site + team
--     page → downstream Workers-AI Profile Filler refines name).
--   - Spec asked for migration number 331; 331/332 were already
--     taken — renumbered to 333.
--   - First draft used `CREATE TEMP VIEW` for the type-string list;
--     D1 rejects DDL beyond CREATE TABLE/INDEX (SQLITE_AUTH), so the
--     list is inlined in each statement.
--   - Architect round-3 feedback: rows that lack a usable canonical
--     domain are LEFT IN PLACE rather than getting a sentinel prefix
--     (which would leave a non-real name as terminal state). They'll
--     surface in follow-up task #13 which can use richer URL parsing
--     than SQL allows.
--   - Brand humanization (`firstround` → "First Round") is out of
--     scope for SQL; the migration outputs single-token
--     capitalization and the downstream AI profile-filler polishes.

-- ============================================================== ENQUEUE
-- Enqueue BEFORE the UPDATEs so each WHERE clause can scope on the
-- type-string predicate (i.e. only rows that ARE corrupted), not on
-- name = brand-from-domain (which would catch legitimate rows like
-- Sequoia/sequoia.com whose name naturally equals the domain token).

-- firms
INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
SELECT
  lower(hex(randomblob(16))),
  'enrich:rename:firm:' || f.domain,
  'task5_backfill',
  'queued',
  'firm_team_crawl',
  f.domain,
  json_object('reason', 'task5_name_backfill', 'entity', 'firm', 'firm_id', f.id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM firms f
WHERE f.name IS NOT NULL
  AND (
    lower(trim(f.name)) IN (
      'vc','pe','angel','accelerator','incubator','nonprofit','bootcamp',
      'network','platform','micro vc','corporate vc','fellow program',
      'fellows program','training program','pitch competition',
      'equity crowdfunding','mentorship','impact investing',
      'venture development','vc fellows program'
    )
    OR lower(trim(f.name)) LIKE 'vc,%'
    OR lower(trim(f.name)) LIKE 'pe,%'
    OR lower(trim(f.name)) LIKE 'angel,%'
    OR lower(trim(f.name)) LIKE 'accelerator,%'
    OR lower(trim(f.name)) LIKE 'incubator,%'
    OR lower(trim(f.name)) LIKE 'nonprofit,%'
    OR lower(trim(f.name)) LIKE 'bootcamp,%'
    OR lower(trim(f.name)) LIKE 'network,%'
    OR lower(trim(f.name)) LIKE 'platform,%'
    OR lower(trim(f.name)) LIKE 'micro vc,%'
    OR lower(trim(f.name)) LIKE 'corporate vc,%'
  )
  AND f.domain IS NOT NULL
  AND length(trim(f.domain)) BETWEEN 4 AND 64
  AND trim(lower(f.domain)) GLOB '*.*'
  AND trim(lower(f.domain)) NOT GLOB '*[ /:@]*'
  AND trim(lower(f.domain)) NOT GLOB '*..*'
  AND substr(trim(lower(f.domain)), 1, 1) GLOB '[a-z0-9]'
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.kind = 'firm_team_crawl'
       AND j.target = f.domain
       AND (j.status IN ('queued', 'running')
            OR j.config_json LIKE '%task5_name_backfill%')
  );

-- leads
INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
SELECT
  lower(hex(randomblob(16))),
  'enrich:rename:lead:' || l.source_domain,
  'task5_backfill',
  'queued',
  'firm_team_crawl',
  l.source_domain,
  json_object('reason', 'task5_name_backfill', 'entity', 'lead', 'lead_id', l.id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM leads l
WHERE l.name IS NOT NULL
  AND (
    lower(trim(l.name)) IN (
      'vc','pe','angel','accelerator','incubator','nonprofit','bootcamp',
      'network','platform','micro vc','corporate vc','fellow program',
      'fellows program','training program','pitch competition',
      'equity crowdfunding','mentorship','impact investing',
      'venture development','vc fellows program'
    )
    OR lower(trim(l.name)) LIKE 'vc,%'
    OR lower(trim(l.name)) LIKE 'pe,%'
    OR lower(trim(l.name)) LIKE 'angel,%'
    OR lower(trim(l.name)) LIKE 'accelerator,%'
    OR lower(trim(l.name)) LIKE 'incubator,%'
    OR lower(trim(l.name)) LIKE 'nonprofit,%'
    OR lower(trim(l.name)) LIKE 'bootcamp,%'
    OR lower(trim(l.name)) LIKE 'network,%'
    OR lower(trim(l.name)) LIKE 'platform,%'
    OR lower(trim(l.name)) LIKE 'micro vc,%'
    OR lower(trim(l.name)) LIKE 'corporate vc,%'
  )
  AND l.source_domain IS NOT NULL
  AND length(trim(l.source_domain)) BETWEEN 4 AND 64
  AND trim(lower(l.source_domain)) GLOB '*.*'
  AND trim(lower(l.source_domain)) NOT GLOB '*[ /:@]*'
  AND trim(lower(l.source_domain)) NOT GLOB '*..*'
  AND substr(trim(lower(l.source_domain)), 1, 1) GLOB '[a-z0-9]'
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.kind = 'firm_team_crawl'
       AND j.target = l.source_domain
       AND (j.status IN ('queued', 'running')
            OR j.config_json LIKE '%task5_name_backfill%')
  );

-- u_entities
INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
SELECT
  lower(hex(randomblob(16))),
  'enrich:rename:entity:' || e.primary_domain,
  'task5_backfill',
  'queued',
  'firm_team_crawl',
  e.primary_domain,
  json_object('reason', 'task5_name_backfill', 'entity', 'u_entity', 'entity_id', e.id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM u_entities e
WHERE e.display_name IS NOT NULL
  AND (
    lower(trim(e.display_name)) IN (
      'vc','pe','angel','accelerator','incubator','nonprofit','bootcamp',
      'network','platform','micro vc','corporate vc','fellow program',
      'fellows program','training program','pitch competition',
      'equity crowdfunding','mentorship','impact investing',
      'venture development','vc fellows program'
    )
    OR lower(trim(e.display_name)) LIKE 'vc,%'
    OR lower(trim(e.display_name)) LIKE 'pe,%'
    OR lower(trim(e.display_name)) LIKE 'angel,%'
    OR lower(trim(e.display_name)) LIKE 'accelerator,%'
    OR lower(trim(e.display_name)) LIKE 'incubator,%'
    OR lower(trim(e.display_name)) LIKE 'nonprofit,%'
    OR lower(trim(e.display_name)) LIKE 'bootcamp,%'
    OR lower(trim(e.display_name)) LIKE 'network,%'
    OR lower(trim(e.display_name)) LIKE 'platform,%'
    OR lower(trim(e.display_name)) LIKE 'micro vc,%'
    OR lower(trim(e.display_name)) LIKE 'corporate vc,%'
  )
  AND e.primary_domain IS NOT NULL
  AND length(trim(e.primary_domain)) BETWEEN 4 AND 64
  AND trim(lower(e.primary_domain)) GLOB '*.*'
  AND trim(lower(e.primary_domain)) NOT GLOB '*[ /:@]*'
  AND trim(lower(e.primary_domain)) NOT GLOB '*..*'
  AND substr(trim(lower(e.primary_domain)), 1, 1) GLOB '[a-z0-9]'
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.kind = 'firm_team_crawl'
       AND j.target = e.primary_domain
       AND (j.status IN ('queued', 'running')
            OR j.config_json LIKE '%task5_name_backfill%')
  );

-- ============================================================== REWRITE

-- firms
UPDATE firms
SET name = upper(substr(
    CASE WHEN instr(trim(lower(domain)), '.') > 1
         THEN substr(trim(lower(domain)), 1, instr(trim(lower(domain)), '.') - 1)
         ELSE trim(lower(domain)) END, 1, 1))
  || substr(
    CASE WHEN instr(trim(lower(domain)), '.') > 1
         THEN substr(trim(lower(domain)), 1, instr(trim(lower(domain)), '.') - 1)
         ELSE trim(lower(domain)) END, 2)
WHERE name IS NOT NULL
  AND (
    lower(trim(name)) IN (
      'vc','pe','angel','accelerator','incubator','nonprofit','bootcamp',
      'network','platform','micro vc','corporate vc','fellow program',
      'fellows program','training program','pitch competition',
      'equity crowdfunding','mentorship','impact investing',
      'venture development','vc fellows program'
    )
    OR lower(trim(name)) LIKE 'vc,%'
    OR lower(trim(name)) LIKE 'pe,%'
    OR lower(trim(name)) LIKE 'angel,%'
    OR lower(trim(name)) LIKE 'accelerator,%'
    OR lower(trim(name)) LIKE 'incubator,%'
    OR lower(trim(name)) LIKE 'nonprofit,%'
    OR lower(trim(name)) LIKE 'bootcamp,%'
    OR lower(trim(name)) LIKE 'network,%'
    OR lower(trim(name)) LIKE 'platform,%'
    OR lower(trim(name)) LIKE 'micro vc,%'
    OR lower(trim(name)) LIKE 'corporate vc,%'
  )
  AND domain IS NOT NULL
  AND length(trim(domain)) BETWEEN 4 AND 64
  AND trim(lower(domain)) GLOB '*.*'
  AND trim(lower(domain)) NOT GLOB '*[ /:@]*'
  AND trim(lower(domain)) NOT GLOB '*..*'
  AND substr(trim(lower(domain)), 1, 1) GLOB '[a-z0-9]';

-- leads
UPDATE leads
SET name = upper(substr(
    CASE WHEN instr(trim(lower(source_domain)), '.') > 1
         THEN substr(trim(lower(source_domain)), 1, instr(trim(lower(source_domain)), '.') - 1)
         ELSE trim(lower(source_domain)) END, 1, 1))
  || substr(
    CASE WHEN instr(trim(lower(source_domain)), '.') > 1
         THEN substr(trim(lower(source_domain)), 1, instr(trim(lower(source_domain)), '.') - 1)
         ELSE trim(lower(source_domain)) END, 2)
WHERE name IS NOT NULL
  AND (
    lower(trim(name)) IN (
      'vc','pe','angel','accelerator','incubator','nonprofit','bootcamp',
      'network','platform','micro vc','corporate vc','fellow program',
      'fellows program','training program','pitch competition',
      'equity crowdfunding','mentorship','impact investing',
      'venture development','vc fellows program'
    )
    OR lower(trim(name)) LIKE 'vc,%'
    OR lower(trim(name)) LIKE 'pe,%'
    OR lower(trim(name)) LIKE 'angel,%'
    OR lower(trim(name)) LIKE 'accelerator,%'
    OR lower(trim(name)) LIKE 'incubator,%'
    OR lower(trim(name)) LIKE 'nonprofit,%'
    OR lower(trim(name)) LIKE 'bootcamp,%'
    OR lower(trim(name)) LIKE 'network,%'
    OR lower(trim(name)) LIKE 'platform,%'
    OR lower(trim(name)) LIKE 'micro vc,%'
    OR lower(trim(name)) LIKE 'corporate vc,%'
  )
  AND source_domain IS NOT NULL
  AND length(trim(source_domain)) BETWEEN 4 AND 64
  AND trim(lower(source_domain)) GLOB '*.*'
  AND trim(lower(source_domain)) NOT GLOB '*[ /:@]*'
  AND trim(lower(source_domain)) NOT GLOB '*..*'
  AND substr(trim(lower(source_domain)), 1, 1) GLOB '[a-z0-9]';

-- u_entities
UPDATE u_entities
SET display_name = upper(substr(
    CASE WHEN instr(trim(lower(primary_domain)), '.') > 1
         THEN substr(trim(lower(primary_domain)), 1, instr(trim(lower(primary_domain)), '.') - 1)
         ELSE trim(lower(primary_domain)) END, 1, 1))
  || substr(
    CASE WHEN instr(trim(lower(primary_domain)), '.') > 1
         THEN substr(trim(lower(primary_domain)), 1, instr(trim(lower(primary_domain)), '.') - 1)
         ELSE trim(lower(primary_domain)) END, 2)
WHERE display_name IS NOT NULL
  AND (
    lower(trim(display_name)) IN (
      'vc','pe','angel','accelerator','incubator','nonprofit','bootcamp',
      'network','platform','micro vc','corporate vc','fellow program',
      'fellows program','training program','pitch competition',
      'equity crowdfunding','mentorship','impact investing',
      'venture development','vc fellows program'
    )
    OR lower(trim(display_name)) LIKE 'vc,%'
    OR lower(trim(display_name)) LIKE 'pe,%'
    OR lower(trim(display_name)) LIKE 'angel,%'
    OR lower(trim(display_name)) LIKE 'accelerator,%'
    OR lower(trim(display_name)) LIKE 'incubator,%'
    OR lower(trim(display_name)) LIKE 'nonprofit,%'
    OR lower(trim(display_name)) LIKE 'bootcamp,%'
    OR lower(trim(display_name)) LIKE 'network,%'
    OR lower(trim(display_name)) LIKE 'platform,%'
    OR lower(trim(display_name)) LIKE 'micro vc,%'
    OR lower(trim(display_name)) LIKE 'corporate vc,%'
  )
  AND primary_domain IS NOT NULL
  AND length(trim(primary_domain)) BETWEEN 4 AND 64
  AND trim(lower(primary_domain)) GLOB '*.*'
  AND trim(lower(primary_domain)) NOT GLOB '*[ /:@]*'
  AND trim(lower(primary_domain)) NOT GLOB '*..*'
  AND substr(trim(lower(primary_domain)), 1, 1) GLOB '[a-z0-9]';
