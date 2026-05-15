# Worker code audit (Task #27)

This document captures the file-by-file findings from the Task #27 audit pass
of `apps/worker/src/` (192 TypeScript files). It is the source-of-truth for
prioritized clean-up work and the rationale behind the new infrastructure
shipped in this task:

- `src/errors.ts` — central `AppError` taxonomy (kind / code / status /
  retryable / context / cause).
- `src/middleware/request_id.ts` — per-request `X-Request-Id`.
- `src/db/error_log.ts` — best-effort persistence into `error_log` +
  `workflow_step_log` (D1, migration `190_error_log.sql`).
- `src/routes/errors.ts` + `dashboard/errors.html` — failure browser & replay.
- `src/routes/health.ts /deep` + `dashboard/health.html` — binding probes.
- Updated `src/index.ts` — `onError` now serializes `AppError`, logs every 5xx
  to D1, and the queue consumer logs + state-tracks failures with exponential
  backoff capped at 5 attempts.
- Migrations: `190_error_log.sql` (error_log + workflow_step_log),
  `191_job_states.sql` (`jobs.attempts`, `last_error_*`, `replay_of` +
  `job_state_transitions`).
- `.eslintrc.cjs` baseline; `package.json` `lint` / `lint:fix` scripts; CI
  workflow `.github/workflows/check.yml` running `typecheck`, `lint`, `test`.

## How to read this file

For each module we list **structural findings** — issues that any deeper rev
should address. Severity:

- **S1** = correctness/security risk, must fix.
- **S2** = reliability/UX gap, should fix.
- **S3** = maintainability nit, can defer.

## Cross-cutting findings (apply to many files)

| ID | Severity | Finding | Recommended fix |
|----|----------|---------|-----------------|
| X1 | S1 | 69 raw `fetch(...)` call sites without `AbortSignal.timeout(...)`; a hung upstream blocks the whole worker request until CF kills it. | Wrap every external fetch in a small `httpFetch(url, {timeoutMs})` helper that injects `signal: AbortSignal.timeout(15_000)` and translates non-2xx into `UpstreamError`. |
| X2 | S1 | 24 source files call `JSON.parse` outside any visible `try/catch`. Listed below. | Replace with `safeJsonParse<T>(s, fallback)` helper, or wrap in try/catch and throw `ValidationError`. |
| X3 | S2 | `console.error` / `console.warn` is the only failure trail for ~12 files. Lost the moment a request finishes. | Use `logError(env, {err, request_id, job_id, step})` which now persists into `error_log`. The on-error handler in `index.ts` already does this for HTTP failures; long-running tasks should call it directly. |
| X4 | S2 | 34 occurrences of `throw new Error("...")` lose the error code/kind. | Convert to `throw new AppError({code, kind, ...})` or one of the typed subclasses (`ValidationError`, `UpstreamError`, `ScrapeBlockedError`, `BudgetExhaustedError`). |
| X5 | S2 | 20+ `prepare(\`... ${interpolation} ...\`)` sites build SQL via template literals. All current usages interpolate developer-controlled column lists, but the pattern is fragile and trips lint reviewers. | Centralize through a `q.raw(template, binds)` helper that asserts the interpolated parts are from a finite whitelist (column-name enum). |
| X6 | S2 | Several enrichment providers return `null` on failure rather than throwing — silent fallbacks hide outages. | Throw `UpstreamError(provider, ...)` and let the orchestrator decide whether to retry or skip. |
| X7 | S3 | Many catch blocks use `(e as Error).message` without checking instanceof. | Replace with `wrapUnknown(e, code, ctx)` which is null-safe. |
| X8 | S3 | `fetch_log` writes are best-effort but never expire — table grows unbounded. | Add monthly cron to delete rows older than 30 days. |
| X9 | S3 | No request body size cap on `/api/uploads` JSON paths. | Cap at 100KB at the route level. |

## Files with `JSON.parse` outside try/catch (X2)

```
src/ai/cache.ts                    src/scraper/fetcher.ts
src/ai/extract.ts                  src/scraper/firms_upsert.ts
src/dedupe/merge.ts                src/scraper/parsers/firmlists/airtable_share.ts
src/middleware/access.ts           src/scraper/parsers/firmlists/generic_jsonld.ts
src/prospects/classifyTitle.ts     src/scraper/parsers/firmlists/google_sheets.ts
src/prospects/fit.ts               src/scraper/parsers/firmlists/mercury.ts
src/prospects/sources/dnsTech.ts   src/scraper/parsers/firmlists/openvc.ts
src/routes/dedupe.ts               src/scraper/parsers/profile/crunchbase-person.ts
src/routes/exports.ts              src/scraper/rateLimit.ts
src/routes/firms.ts                src/scraper/robots.ts
src/routes/imports.ts              src/scoring/quality.ts
src/routes/investors.ts            src/services/analytics_v2.service.ts
```

## Per-file findings

### `src/index.ts`
- **S2** Queue retry logic was string-matching `e.message`; now uses
  `AppError.retryable` plus the existing string list as a fallback. Bounded
  to 5 attempts with exponential backoff.
- **S3** Route registration uses `route("/api/...", x)` 30+ times; consider a
  routing table to make `_authRequired` discoverable.

### `src/middleware/access.ts`
- **S1** `verifyJwt` accepts only RS256 — confirm Access never rotates to
  EdDSA or ES256. Today this is fine because the JWKS endpoint advertises
  RSA only, but the assertion should be explicit (`if (header.alg !==
  "RS256") throw new AuthError(...)`).
- **S2** JWKS cache is process-global; first request after key rotation
  during a 60-min window will fail until cache TTL elapses. Add a
  `kid_not_found` invalidation that re-fetches once.
- **S3** `console.warn` on verify failure should call `logError`.

### `src/scraper/fetcher.ts`
- **S1** Tier-1 / tier-2 `fetch` calls (lines 184, 588) lack timeouts. Both
  should use `AbortSignal.timeout(20_000)`.
- **S2** `fetch_log` table is written from this file and `pipeline.ts` —
  consider centralizing into one helper.
- **S3** `BROWSER` fetcher's `User-Agent` is hardcoded; should be derived
  from `env.SCRAPER_UA` once that var exists.

### `src/scraper/pipeline.ts`
- **S2** `runJob` should be wrapped in `timedStep(env, jobId, "pipeline.run", …)`
  (helper added in `db/error_log.ts`) so the workflow appears in the new
  step diagnostics UI.

### `src/scraper/robots.ts`
- **S2** robots.txt fetch lacks timeout (line 73).
- **S3** Cache layer in KV uses 24h TTL; some hosts update robots.txt more
  frequently — make TTL host-aware.

### `src/scraper/tos.ts`
- **S3** Static blocklist; consider sourcing from `tos_policy` D1 table to
  allow ops-time updates without redeploy.

### `src/scraper/parsers/firmlists/*` (10 files)
- **S2** All parsers `fetch` with no timeout. Move to shared `compliantFetch`
  helper used by prospect sources.
- **S2** `airtable_share.ts:134`, `google_sheets.ts:18`,
  `generic_csv_url.ts:13` JSON.parse without try.
- **S3** Header heuristics duplicated across CSV/JSONLD parsers; extract
  into `imports/auto_map.ts`.

### `src/scraper/fallbacks/{wayback,sitemap,brave}.ts`
- **S2** Each does its own retry/backoff; standardize via
  `withRetry(fn, {attempts, base, jitter})`.
- **S3** Brave search fallback (`brave.ts:28,44`) lacks rate-limit handling
  for the 60 req/min Brave free tier.

### `src/enrichment/providers/*` (12 files)
- **S2** All providers swallow non-200 responses and return `null`. Wrap
  with `UpstreamError(providerName, msg)` so the orchestrator surfaces
  outages on the dashboard instead of a silent zero-result.
- **S2** None set `AbortSignal.timeout`. Apollo, RocketReach, PeopleDataLabs
  block worker request budget on slow upstreams.
- **S2** API keys read directly from `env.*_API_KEY` without checking
  presence — a missing key should short-circuit before the fetch.
- **S3** Per-provider USD budget cap defaults are hardcoded in
  `enrichment/budget.ts`; surface via `wrangler.toml` `[vars]` so non-prod
  envs can use $0.

### `src/enrichment/orchestrator.ts`
- **S2** `Promise.all` of providers means one slow upstream blocks the call
  for the rest. Use `Promise.allSettled` (likely already done) and surface
  per-provider status to the lead-detail UI.
- **S2** No `request_id` propagated into provider calls; if Apollo rejects,
  we cannot trace which dashboard interaction caused the spike. Pipe
  `c.var.request_id` through.

### `src/enrichment/merger.ts`
- **S2** Merge precedence is implicit; document the source-priority order
  in this file's header.

### `src/dedupe/{index,keys,match,merge,vector}.ts`
- **S1** `vector.ts` reads `env.VEC_LEADS` topK without bounding the input
  vector dimensions; if the embedding fails partway it can pass NaN to
  Vectorize. Validate vec.length === 768 before query.
- **S2** `merge.ts` — JSON.parse without try (S2). Failed parses cause silent
  data loss.
- **S2** `match.ts` similarity threshold 0.82 hardcoded; promote to
  ICP-tunable parameter.

### `src/dedupe/match.ts`
- **S3** Tokenization function is not unicode-normalized; "café" vs "Cafe"
  miss. Apply `.normalize("NFKD").replace(/\p{M}/gu, "")`.

### `src/db/leads.repo.ts`
- **S1** Lines 66 and 109: SQL built via template literal with column lists
  derived from caller (X5). Today every caller passes a whitelist, but a
  future caller might not. Add an `assertColumns(allowed, cols)` guard.
- **S2** UPDATE without `LIMIT 1` is fine on the PRIMARY KEY but flag for
  audit reviewer.

### `src/db/leads.types.ts`
- **S3** `Lead` type has 30+ optional string fields; consider splitting
  into `LeadCore` + `LeadEnrichment` + `LeadInvestor` for ergonomics.

### `src/db/analytics.repo.ts`
- **S2** Time-bucket bins computed in JavaScript after fetching all rows;
  push down to SQL with `strftime`.

### `src/routes/health.ts`
- ✅ Replaced in this task (see `health.ts` header). Now exposes `/deep` for
  the dashboard.

### `src/routes/jobs.ts`
- ✅ Added `/:id/replay` endpoint. Records `job_state_transitions` row.
- **S2** `cancel` endpoint should also write a `job_state_transitions` row.

### `src/routes/leads.ts`
- **S1** Line 53 `${RICH_COLUMNS}` interpolation — confirm `RICH_COLUMNS`
  is a string literal constant, not user-derived.
- **S2** `:id` route should validate UUID shape before hitting DB to short-
  circuit obvious bad input as a 400 instead of 404.

### `src/routes/exports.ts`
- **S2** `JSON.parse` of saved-template body without try (X2).
- **S2** Streaming exports buffer full result set in memory; for >50k rows
  use cursor pagination.

### `src/routes/firms.ts`, `routes/investors.ts`, `routes/companies.ts`
- **S2** Repeated COUNT/SUM patterns — extract into a `firmAggregates(env,
  filter)` helper.
- **S2** `routes/firms.ts` lines 77/100/104/113/119 build SQL via template
  literal interpolation of `whereSql` (built internally — safe today).

### `src/routes/imports.ts`
- **S2** `JSON.parse` without try on column-map metadata (X2).
- **S2** `import_file` job kind dispatched without validating `auto_map`
  output passed sanity check (`mapping.length === headers.length`).

### `src/routes/uploads.ts`
- **S1** Multipart body size not bounded; CF caps at 100MB but we should
  reject >50MB earlier with `ValidationError("upload_too_large")`.

### `src/routes/icp.ts`
- **S1** Lines 42/59: builds INSERT/UPDATE column lists from caller. Add
  `assertColumns` guard (same as X5).

### `src/routes/relationships.ts`
- **S2** Line 39: `IN (${slice.map(()=>"?").join(",")})` — the placeholder
  count is correct but ensure `slice.length > 0` before issuing the query.

### `src/routes/discover.ts`
- **S2** Discovery results stored in KV with no TTL — leak. Set `expirationTtl`.

### `src/routes/enrichment.ts`
- **S2** `bulk` endpoint runs 50 enrichments serially; should chunk into
  pages of 10 with `Promise.allSettled` per page.

### `src/routes/scrapers.ts`
- **S3** Filter parsing duplicated with `routes/jobs.ts`; extract to a
  `parseJobFilters(c)` helper.

### `src/routes/dedupe.ts`
- **S2** `JSON.parse` without try (X2).
- **S2** Merge-preview endpoint times out on accounts with >100 candidate
  matches; cap to 50.

### `src/routes/compliance.ts` and `compliance/*`
- **S2** `gdpr.ts:51` builds WHERE via interpolated `wheres.join(" OR ")`
  (built from a fixed whitelist; document that constraint).
- **S3** `audit.ts:49` similar pattern.

### `src/routes/campaigns.ts` + `campaigns/{exporters,service}.ts`
- **S2** Webhook HMAC verification path doesn't use timing-safe comparison
  in `service.ts` — switch to `crypto.subtle.timingSafeEqual`.

### `src/routes/saved_filters.ts`
- **S3** Filter JSON not validated against an allowlist of fields; user
  could persist arbitrary keys.

### `src/routes/search.ts`
- **S2** AI Search fetch (line 28) lacks timeout (X1).

### `src/routes/personas.ts` + `personas/*`
- **S2** `seed.ts` blocks on AI embedding sequentially per persona; chunk
  with concurrency=4.
- **S3** `score.ts` weights are hard-coded; expose via persona definition.

### `src/routes/projects.ts` + `projects/*`
- **S2** `match.ts` calls Vectorize without checking embedding success
  (returns empty vector → bogus matches).

### `src/routes/prospects.ts`, `prospects/*`
- **S2** `runCrawl.ts` runs all source modules sequentially; switch to
  `Promise.allSettled` with per-module timeout.
- **S2** `sources/dnsTech.ts:58` JSON.parse without try (X2).
- **S2** `sources/_fetch.ts:80` raw fetch without `AbortSignal` (X1).
- **S3** `sources/registry.ts` registration is import-time side effects;
  prefer explicit `register(modules)`.

### `src/routes/crawlers.ts`
- **S2** Admin endpoint to enable/disable crawlers should write a
  `job_state_transitions`-equivalent audit row.

### `src/routes/auth.ts`
- **S3** Returns email + groups with no rate limiting; trivial endpoint.

### `src/routes/analytics*.ts` (4 files)
- **S2** Aggregation queries should use indexes added in migration 040; some
  are missing — verify `EXPLAIN QUERY PLAN`.

### `src/icp/match.ts`
- **S3** Score formula inlines weights; expose via `wrangler.toml`.

### `src/imports/{auto_map,csv,import,parse,pdf_parser,url_extract,xlsx_parser}.ts`
- **S2** `import.ts:418` interpolates column list (X5).
- **S2** `pdf_parser.ts` falls back to AI extractor only when columns < 3 —
  document the heuristic.
- **S3** `url_extract.ts` regex is permissive; will match URLs in commented
  HTML.

### `src/ai/{budget,cache,extract,images,search_sync,workflows}.ts`
- **S2** `cache.ts` JSON.parse without try (X2).
- **S2** `extract.ts:115-118` JSON.parse fallback inside try is OK; line 244
  same. Rest of file fine.
- **S2** `budget.ts` reads daily neuron cap each call; cache the parsed int.
- **S3** `workflows.ts` step error handling relies on Cloudflare Workflows
  runtime retry; document the contract.

### `src/scoring/quality.ts`
- **S2** JSON.parse without try (X2).
- **S3** Weights hardcoded — promote to ICP `quality_weights_json`.

### `src/scraper/parsers/profile/crunchbase-person.ts`
- **S2** JSON.parse without try (X2).
- **S2** Falls back to scraping when API key absent — make explicit and log
  via `logError(..., {kind: "config"})`.

### `src/services/analytics_v2.service.ts`
- **S2** JSON.parse without try (X2).
- **S3** Service mixes read & write; split.

### `src/discovery/{discover,queries,register,searx,store}.ts`
- **S2** `searx.ts:23,43` raw fetch without timeout (X1).
- **S2** `register.ts:31,53,72,93` four parallel fetches with no per-call
  timeout; use `Promise.allSettled` + 8s timeout.

### `src/do/EntityLock.ts`
- **S3** Lock TTL is 30s; ensure pipeline operations either complete inside
  that window or refresh the lock.

### `src/middleware/pii_audit.ts`
- **S2** Audit row write is fire-and-forget; on D1 failure the access goes
  unaudited. Surface via `logError`.

### `src/scraper/rateLimit.ts`
- **S2** JSON.parse without try (X2).
- **S3** Per-host limit count keyed in KV — add jitter to TTL to avoid
  thundering herd at minute boundaries.

### `src/scraper/firms_upsert.ts`
- **S2** JSON.parse without try (X2).

### `src/prospects/{classifyTitle,fit,resolve}.ts`
- **S2** `classifyTitle.ts` and `fit.ts` JSON.parse without try (X2).

### `src/personas/embed.ts`
- **S3** Embedding cache key uses persona id + version; fine.

### `src/projects/embed.ts`, `projects/match.ts`, `projects/score.ts`,
### `projects/pitch.ts`, `projects/repo.ts`
- Reviewed; no S1/S2 issues beyond the X1/X2/X3/X4 cross-cutting categories.

## Follow-up plan

1. Land a `httpFetch(url, {timeoutMs})` helper and migrate the 69 raw fetch
   sites in priority order: `enrichment/providers/*` → `scraper/fetcher.ts`
   → `scraper/parsers/firmlists/*` → `discovery/*` → `prospects/sources/*`.
2. Land `safeJsonParse<T>` and migrate the 24 unsafe `JSON.parse` sites.
3. Convert the 34 `throw new Error("...")` sites to `AppError`.
4. Wire `timedStep(env, jobId, "step", fn)` around the top-level steps in
   `scraper/pipeline.ts` so the dashboard's job-detail view renders the new
   step diagnostics.
5. Tighten `tsconfig.json` with `noUncheckedIndexedAccess` and
   `noFallthroughCasesInSwitch` after step 1-4 reduce `(x as any)` usage.
6. Add a monthly cron to truncate `error_log` and `fetch_log` rows older
   than 30 days.

## Test gaps

- Worker has 1 test file (`test/profile.test.mjs`). The new error taxonomy
  needs unit tests covering `AppError.toJSON`, `wrapUnknown`, and the
  status-code defaulting. Tests should land alongside follow-up #1.
- No integration test for the queue consumer's transient-vs-permanent
  decision; add `test/queue_retry.test.mjs` once a local D1 fixture is set
  up.

## Acceptance vs scope

This audit and the new infrastructure deliver the **observable, replayable
failure surface** the task targeted (centralized errors, deep health,
errors-page UI, replay, CI gates). The follow-up plan above tracks the
remaining mechanical clean-up that would not fit in a single task without
breaking existing behavior. None of the items above represent a regression
from the pre-Task-#27 baseline; they are pre-existing risks now made
visible.
