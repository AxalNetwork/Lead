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
--   1. Identifies corrupted rows in three tables (firms, leads,
--      u_entities) via the type-string allowlist below — same source
--      of truth as TYPE_STRING_REGEX in
--      src/services/csv/headerDetector.ts.
--   2. Heuristically derives a brand token from the row's apex domain
--      ("firstround.com" → "Firstround") and writes it back. Only
--      runs when the source column is a clean lower-case host (matches
--      GLOB pattern `*.*` with no `/`, `:`, space, or `@`). Anything
--      else is left alone so we never overwrite a corrupted row with
--      a worse value (e.g. `Http://foo`, `Localhost`).
--   3. Is idempotent: the WHERE clause filters on the corrupted-name
--      pattern, so re-running on already-fixed rows is a no-op.
--
-- Drift from task spec:
--   - Spec referenced `entities.name`; the unified entity table is
--     `u_entities` with column `display_name`.
--   - Spec asked the migration to "enqueue an enrich_entity job". No
--     such JobKind exists (src/types.ts); the downstream "Workers-AI
--     Profile Filler" task covers per-entity AI re-enrichment and
--     will pick up renamed rows on its next sweep.
--   - Spec asked for migration number 331; 331/332 were already
--     taken — renumbered to 333.
--   - First draft used `CREATE TEMP VIEW` for the type-string list;
--     D1 rejects DDL beyond CREATE TABLE/INDEX in user migrations
--     (SQLITE_AUTH), so the list is inlined in each UPDATE.
--   - Architect review (round 1) flagged that deriving from
--     `firms.website` / `leads.personal_url` / `u_entities.primary_url`
--     can write junk ("Http://x", "Localhost") into the name. Hardened
--     to only derive from the canonical *domain* columns
--     (`firms.domain`, `u_entities.primary_domain`) when those pass a
--     strict GLOB host shape check. `leads.name` has no canonical
--     domain column — left alone here; downstream profile-filler
--     task will refine.
--   - Brand humanization (`firstround` → "First Round") is out of
--     scope for SQL; the migration outputs single-token capitalization
--     and the downstream AI profile-filler can polish if needed.

-- ---------------------------------------------------------------- firms
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
  -- Strict host-shape guard: must be a clean lower-case domain.
  AND domain IS NOT NULL
  AND length(trim(domain)) BETWEEN 4 AND 64
  AND trim(lower(domain)) GLOB '*.*'
  AND trim(lower(domain)) NOT GLOB '*[ /:@]*'
  AND trim(lower(domain)) NOT GLOB '*..*'
  AND substr(trim(lower(domain)), 1, 1) GLOB '[a-z0-9]';

-- ---------------------------------------------------------------- leads
-- Round-2 architect feedback: backfill leads too. `leads.name` has no
-- canonical domain column but `leads.source_domain` is the apex host
-- of the page the lead was originally scraped from — same shape as
-- `firms.domain`. Strict GLOB host-shape guard.
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

-- ------------------------------------------------------------- u_entities
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

-- ---------------------------------------- post-rename enrichment enqueue
-- Architect round-2 feedback: enqueue an enrichment job per renamed
-- row so downstream pipelines refresh the firm/lead profile against
-- the corrected name. No `enrich_firm`/`enrich_entity` JobKind exists
-- in this codebase (see src/types.ts), so we use `firm_team_crawl`
-- which already re-crawls the firm's site + team page and is the
-- nearest existing equivalent. The Workers-AI Profile Filler task
-- downstream will further refine display_name humanization.
--
-- Idempotency: only enqueue when no `queued|running` firm_team_crawl
-- already targets the same domain — re-running the migration won't
-- pile up duplicates.
INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
SELECT
  lower(hex(randomblob(16))),
  'enrich:rename:' || f.domain,
  'task5_backfill',
  'queued',
  'firm_team_crawl',
  f.domain,
  json_object('reason', 'task5_name_backfill', 'firm_id', f.id),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM firms f
WHERE f.domain IS NOT NULL
  AND length(trim(f.domain)) BETWEEN 4 AND 64
  AND trim(lower(f.domain)) GLOB '*.*'
  AND trim(lower(f.domain)) NOT GLOB '*[ /:@]*'
  -- Only firms whose name now equals the brand-from-domain heuristic
  -- output (i.e. rows this migration just rewrote).
  AND f.name = (
    upper(substr(
      CASE WHEN instr(trim(lower(f.domain)), '.') > 1
           THEN substr(trim(lower(f.domain)), 1, instr(trim(lower(f.domain)), '.') - 1)
           ELSE trim(lower(f.domain)) END, 1, 1))
    || substr(
      CASE WHEN instr(trim(lower(f.domain)), '.') > 1
           THEN substr(trim(lower(f.domain)), 1, instr(trim(lower(f.domain)), '.') - 1)
           ELSE trim(lower(f.domain)) END, 2)
  )
  AND NOT EXISTS (
    SELECT 1 FROM jobs j
     WHERE j.kind = 'firm_team_crawl'
       AND j.target = f.domain
       AND j.status IN ('queued', 'running')
  );
