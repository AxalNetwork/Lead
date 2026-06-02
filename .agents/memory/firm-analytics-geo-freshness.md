---
name: Firm analytics geo freshness
description: Why backfilling firms.hq_country_iso2 doesn't immediately change the geo map, and how country resolution is canonicalized.
---

# Firm analytics geo map freshness

The firm analytics geo endpoint (`GET /api/analytics/firms/geo`) prefers the
**materialized** `firm_analytics_daily` payload and only falls back to a live
query when no materialized row exists. So writing `firms.hq_country_iso2`
(e.g. via the geo backfill) does NOT change what the map shows until
`materializeFirmAnalytics(env)` re-runs.

`materializeFirmAnalytics` is invoked from the nightly analytics aggregator
(`runNightlyAggregator`), which runs on a **different cron branch** than the
inline geo backfill. So a backfill must re-materialize itself to be visible.

**Why:** these two pieces live on separate cron schedules; relying on "the
aggregator will pick it up later" leaves the map stale for up to a day.

**How to apply:** any routine that mutates firm fields feeding the geo / heatmap
/ sector aggregates must call `materializeFirmAnalytics` after it changes data
if it needs the change visible promptly (the manual backfill route and the
nightly backfill both do this, gated on `resolved > 0`).

## Country-name → ISO2: which lookup is canonical
Use `imports/coercers.parseCountryIso2` (backed by the full
`imports/country_iso2.ts` `COUNTRY_NAME_TO_ISO2` table + flag-emoji + bare-ISO2
handling) for all firm country resolution. The older
`scraper/normalize.countryNameToIso2` is a tiny seed map — do not reach for it
for new resolution paths.
