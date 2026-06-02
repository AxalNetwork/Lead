---
name: Investor profile data split (legacy store vs unified entity store)
description: Why investor profiles render nearly empty, and where their real data actually lives.
---

# Investor profile data split

The investor profile read path (`apps/worker/src/routes/investors.ts`
`GET /:id/profile`) reads the **legacy Task-#24 tables**: scalar columns on
`leads`, plus `companies` and `investor_investments`. But the live crawl/enrich
pipelines write the **unified entity store** (`facts` / `entity_summary` /
`channels` / `rel_edges`) and firm crawls. `investor_investments` has **no live
writer** — that's why investor profiles look nearly empty even when crawl data
exists.

The real portfolio sources are:
- `firm_portfolio` (populated by firm crawls) — firm-level holdings.
- `leads.companies_json` (angels) — per-person investment entries.

**Why:** the platform migrated to the unified entity store but the investor
profile UI/route was never repointed; the two stores were never bridged.

**How to apply:** when an investor (or any legacy-table-backed) profile shows
empty despite known crawl data, check whether the read path is on the legacy
tables while writers target the entity store. The Task #31 fix bridges this:
`services/investor_portfolio.ts` rebuilds `investor_investments` from
`firm_portfolio` + `leads.companies_json` (state-convergent on
`source_provider LIKE 'derive:%'`), and `services/investor_entity_merge.ts`
overlays entity-store fields (bio/thesis/check-size/focus/socials) onto the
legacy profile with legacy-wins/overlay-fills-gaps coalescing. Partner fan-out
(a firm's portfolio inherited by its partners) must use investor-specific title
matching only — generic exec tokens like "chief" misattribute whole portfolios
to chief-of-staff/COO.
