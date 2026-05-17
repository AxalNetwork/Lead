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
