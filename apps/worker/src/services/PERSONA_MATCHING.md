# Persona ↔ Entity matching (Task #8)

## Canonical store: `persona_entity_matches`

Task #8 introduces `persona_entity_matches` (migration 331) as the
**unified-graph** matcher store. It coexists with the legacy
`persona_matches` table (migration 170) intentionally:

| Table                     | Created by | Domain                                                                 | Status            |
| ------------------------- | ---------- | ---------------------------------------------------------------------- | ----------------- |
| `persona_matches`         | mig 170    | legacy persona ↔ raw-lead matches (pre-unified-graph)                  | read-only legacy  |
| `persona_entity_matches`  | mig 331    | persona ↔ `u_entities` (unified graph) with component evidence + rationale | **canonical**     |

Migration 331 backfills auto rows from `persona_matches` via
`entity_legacy_map` (raw_id → entity_id) so historical data isn't lost.
Manual rows are preserved (`source='manual'`) and never overwritten by
the auto scorer.

**Downstream consumers should read from `persona_entity_matches` and
treat `persona_matches` as a frozen legacy compatibility table.** New
features (dashboard candidates view, exports, alerts) must use the
unified-graph table; do not extend the legacy table.

Migration ordering: 170 (personas) → 200 (u_entities) → 280
(entity_legacy_map) → 331. If 331's stub-table block fires in your
migration log, your DB applied 331 out of order — investigate.

## Scoring contract

Weights (sum = 1.00):
- title_sim       0.25
- seniority       0.15
- function        0.15
- industry        0.15
- company_size    0.10
- stage           0.10
- geo             0.10

`title_sim` input: per the Task #8 spec, the embed text is composed
**only** from structured target fields — `buyer_titles_json`,
`buyer_seniority_json`, `buyer_departments_json`. Long-form notes
(thesis, free text) are explicitly excluded so the component is
reproducible and explainable.

**Embedding cache (precompute/reuse pattern).** Both persona and
entity title embeddings are cached in D1 (`persona_title_embeddings`,
`entity_title_embeddings`) keyed by content SHA-256. The hot path is
a D1 lookup; `AI.embed` only fires on cache miss (new row, or title
text changed). This matches the Vectorize precompute/reuse pattern
from Task #7 personas — bulk scoring no longer pays per-entity
embedding cost beyond first-touch. Caches are invalidated
automatically when content_hash differs.

## Backwards-compatibility view

Consumers still reading the legacy `persona_matches` column shape
(`persona_id, entity_kind, entity_id, fit_score, components_json,
computed_at`) can read `persona_matches_v2`, a view over
`persona_entity_matches` that back-scales `score` to 0..100 and
infers `entity_kind` from `u_entities.kind`. New code should read
`persona_entity_matches` directly for full component breakdown +
rationale + source.

## Manual-row preservation across migration

Operators upgrading from the pre-Task-#8 flow with manually-pinned
matches should populate `persona_match_manual_overrides`
(persona_id, entity_id) **before** running migration 331. Matched
rows are stamped `source='manual'` with `model_version='manual-legacy'`
during backfill, so the manual preservation contract holds across
the migration boundary. Greenfield deploys leave the table empty.
Post-Task-#8, manual matches are written to `persona_entity_matches`
directly by the routes layer with `source='manual'`.

## Triggers

- persona create/edit/clone → `dispatchPersonaEntityMatch` →
  `WF_PERSONA_ENTITY_MATCH` (no maxEntities cap; processes every
  active person entity)
- entity create (kind='person'), `insertFact` for relevant predicates,
  `addCareerEntry` → debounced per-entity rematch via
  `personaMatchTrigger`
- nightly cron → `WF_PERSONA_MATCH_REFRESH` re-scores auto rows older
  than 30 days

## Failure visibility (SLO)

`persona_match_jobs` (mig 331) records dispatch + scoring outcomes
(ok/halted/failed/cancelled) with `slo_violation: true` flagged in
`details_json` whenever the bounded inline fallback runs. Console logs
also emit a literal `SLO_VIOLATION ...` token so log aggregators can
alert on it.

Query recent SLO misses:

```sql
SELECT created_at, kind, status, persona_id, details_json
FROM persona_match_jobs
WHERE json_extract(details_json, '$.slo_violation') = 1
ORDER BY created_at DESC LIMIT 50;
```

### Alerting

Wire this query into the monitoring dashboard with a 15-minute
rolling window threshold of `count(*) >= 3` to detect workflow-plane
outages quickly. The console-log token `SLO_VIOLATION` is also
indexed by log aggregators and can drive a parallel page-on-error
alert. The nightly cron's migration-order guard (`scheduled.ts`)
throws hard in `ENVIRONMENT=production` if it detects the 331 stub
serving as canonical `u_entities`, so a misconfigured prod deploy
fails the cron tick instead of silently returning empty matches.

### Operational prerequisites (rollout runbook)

Before applying migration 331 to an environment that has manually
pinned legacy `persona_matches` rows, the operator MUST populate
`persona_match_manual_overrides` with the (persona_id, entity_id)
pairs to be preserved. The schema is created in migration 331
itself, so the safe rollout sequence is:

1. Deploy migration 331 to a staging copy of the prod DB.
2. Run an audit query to identify legacy manual rows (or import them
   from the operator's pin log).
3. `INSERT` those pairs into `persona_match_manual_overrides`.
4. Re-run the backfill SELECT manually (the migration's INSERT OR
   IGNORE is idempotent), OR drop and re-apply 331.
5. Apply to production.

The backfill cannot auto-derive manual provenance because legacy
`persona_matches` has no `source` column. **Migration 331 hard-fails
with a `CHECK constraint failed` error (raised by an inline
`CREATE TEMP TABLE … CHECK(ok=1)` guard) if `persona_matches` has any
rows and `persona_match_manual_overrides` is empty.** SQLite's `1/0`
evaluates to NULL rather than raising, so the CHECK-constraint
pattern is the portable D1/SQLite-aborting primitive. Operators must
either pre-populate the override table with the manual pairs to
preserve, OR explicitly opt out by inserting a no-op sentinel row if
there genuinely are no manual pins. Greenfield deploys (empty
`persona_matches`) pass through cleanly with no operator action.

**Release checklist gate.** Before applying migration 331 to any
environment that has historically run the legacy `persona_matches`
matcher (Task #46 accounts/buyers), the deploy pipeline must:
1. Query `SELECT COUNT(*) FROM persona_matches` on the target DB.
2. If non-zero, require an explicit operator-signed manifest listing
   the (persona_id, entity_id) pairs to preserve as manual.
3. Apply those rows to `persona_match_manual_overrides` (created
   beforehand if needed) before running the 331 migration.
4. If the operator has zero manual pins to preserve, insert a single
   sentinel row (e.g. `('__sentinel__','__sentinel__')`) to bypass
   the guard while documenting the decision in the release notes.

### Inline-scoring feature flag

`PERSONA_MATCH_INLINE_FALLBACK` (`"1"` | `"0"` | unset) gates the
request-time inline scoring fallback used when the workflow plane is
unreachable. Default: ON in dev/staging, OFF in
`ENVIRONMENT=production`. This aligns the hot path with the
"all scoring in workflows/queues/cron" architectural rule. When the
flag is OFF and workflow dispatch fails, the dispatch records a
`status='halted'` row with `slo_violation: true` and
`reason: 'inline_disabled_in_production'` so ops can page on it.

### Deferred follow-up

A route-level integration test for `GET /api/personas/:id/candidates`
(asserting component keys + rationale + source through the actual
Hono handler) is tracked as follow-up — it requires a Miniflare
harness not currently wired into the node:test runner. The DB
contract test (`test/personaMatchingDbContract.test.mjs`) covers
the storage layer; the acceptance harness covers ranking quality.
