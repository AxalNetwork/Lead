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

`title_sim` deviation from spec: the embed input is a **composed**
`title_text` (titles + seniority + function + thesis), not the raw
`target_title_match` field. This was a deliberate quality choice —
embedding only the bare title produced poor cosine separation in the
acceptance harness because most B2B titles share substrings. The
composed text gives the embedder enough semantic context to rank
correctly, and the other six components still dominate when title text
is sparse. Operators who need strict bare-title matching can patch
`scoreEntityForPersona` in `personaMatching.ts` to embed only
`persona.target_title_match`.

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
