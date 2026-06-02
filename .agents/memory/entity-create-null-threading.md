---
name: createEntity null must be threaded, never faked
description: createEntity/resolvers return null on the garbage-guard path; every caller must skip, never fabricate an entity_id
---

`createEntity` (`apps/worker/src/entities/roles.ts`) returns `EntityRow | null`
— it returns **null** (plus a `data_quality_log` audit row, no throw) whenever
the Task #9 `isGarbage` pre-insert guard rejects the name (HTML titles, nav
strings, empty). This nullability propagates up through every resolver that
wraps it: `resolveSecEntity` (secEdgar/xref.ts), `resolveInvestor`,
`resolveFundName`, `resolveIntlEntity`, `ensureLpEntity`.

**Rule:** any caller of these resolvers must treat null as "unresolved" and
**skip** the affected row — primary-entity failure → early-return a
`{skipped:true, reason:"*_name_rejected"}` result; loop-item failure →
`continue`. Never fabricate or default an `entity_id`, and never let a typed
return signature lie about non-nullness (that just hides a latent
`Cannot read properties of null (reading 'id'/'entity_id')` crash that tsc
will eventually flag).

**Why:** the garbage guard exists precisely to keep junk out of `u_entities`;
faking an id to satisfy a non-null type would write corrupt provenance, and the
codebase ethos is honest graceful degradation over silent fallbacks.

**How to apply:** when you widen a resolver to `... | null`, immediately audit
every call site for unguarded `.entity_id` / `.id` derefs — the SEC persist
layer (secEdgar/persist.ts) has ~10 such sites across persistAdv/FormD/13F/
13D/Form4/S1/8K/10K/PF. Lookup-only callers (`createIfMissing:false`) were
already null-safe via `r?.entity_id ?? null`.
