# Bug Triage Pass (Task #2) — May 2026

Status vocabulary (per task spec): `fixed` / `not-applicable` / `follow-up`.

| # | Item | Status | Files | Note |
|---|------|--------|-------|------|
| 1 | Missing route mounts | not-applicable | `apps/worker/src/routes/*.ts`, `apps/worker/src/index.ts` | Enumerated all 43 files under `src/routes/`. 42 are Hono apps and every one is imported + `api.route(...)`'d in `index.ts`. The 43rd (`_firms_filter.ts`) is a helper imported by `firms.ts`, not a router. No routes were dropped on the floor. |
| 2 | Foreign-key targets exist | follow-up | `apps/worker/migrations/*.sql` | Spot-checked recent migrations (200–331): every `REFERENCES` resolves to a table created earlier. A full cumulative ordered walk across all 62 migrations is deferred to Task #4 ("Fix Critical Bugs Blocking Migrations & Routes"), which already depends on this task and explicitly covers deeper migration repair. |
| 3 | D1-incompatible `ON CONFLICT` | follow-up | `apps/worker/migrations/*.sql` | Spot-checked recent `ON CONFLICT(...)` clauses; each had a matching `UNIQUE` constraint or `UNIQUE INDEX` earlier. A full cumulative audit is deferred to Task #4 alongside item #2. |
| 4 | Missing `await` on D1 calls | not-applicable | `apps/worker/src/**/*.ts` | Scanned every `.prepare(...)` callsite ending in `.run()` / `.first()` / `.all()` / `.raw()` via a custom AST-light scan. Five hits in `apps/worker/src/entities/query.ts:24-28` are inside `Promise.all([...])` and therefore awaited by the outer `await`. Zero genuine missing awaits. |
| 5 | Error boundary doesn't leak stacks | fixed | `apps/worker/src/index.ts`, `apps/worker/src/types.ts`, `apps/worker/test/access_guard.test.mjs` | `api.onError(...)` now branches on `env.ENVIRONMENT === "production" \|\| !env.DEBUG`. In prod it returns exactly `{ error: { code, message } }` — never `cause.stack`, and for internal/5xx errors the message is replaced with the constant `"Internal server error"` so raw SQL / provider / platform error strings cannot leak. Dev keeps the rich legacy envelope. `Env` gained `ENVIRONMENT?` and `DEBUG?`. CI assertion in `test/access_guard.test.mjs` locks the envelope shape. |
| 6 | Auth bypass scan | fixed | `apps/worker/src/index.ts`, `apps/worker/src/routes/campaigns.ts`, `apps/worker/test/access_guard.test.mjs` | `api.use("/api/*", accessGuard)` now appears after the two documented public mounts only. **Public allow-list per task #2 spec: `/api/health` and `/api/webhooks/*`.** The HMAC-signed marketing webhook was relocated from `/api/campaigns` (which was the wrong namespace) to `/api/webhooks/campaigns` so it sits under the spec's `/api/webhooks/*` prefix. The non-`/api` cheap-liveness probe `/health` remains public. A new CI test (`test/access_guard.test.mjs`) introspects `src/index.ts` and fails if any `/api/*` route is mounted before `accessGuard` outside the explicit `PUBLIC_ALLOW_LIST` set + `PUBLIC_PREFIX_ALLOW_LIST = ["/api/webhooks/"]`. |
| 7 | Queue retry storm | not-applicable | `apps/worker/src/index.ts` | The `queue(...)` handler calls `msg.retry()` at most once per message-handling invocation (one decision per iteration). Retry cap was already lowered from 5 → 3 attempts; after 3 the message is `ack()`'d and the job is transitioned to `dead_letter` (with a state-machine guard so terminal states set by the sweeper are not clobbered). |
| 8 | Cloudflare bindings | fixed | `apps/worker/wrangler.toml`, `apps/worker/src/types.ts` | Added `[[r2_buckets]] binding="IMPORTS"` (Task #57 inbox), `[[r2_buckets]] binding="TRANSCRIPTS"` (Task #43 call transcripts), and `[[vectorize]] binding="VECTORIZE_ENTITIES" index_name="axal-entities-768"` (Tasks #7 / #8 / #9). `[ai] binding="AI"` was already declared. `Env` updated with `IMPORTS?`, `TRANSCRIPTS?`, `VECTORIZE_ENTITIES?` so TypeScript catches future drift. |
| 9 | Verification | fixed | — | `npm run typecheck` clean; `npm run typecheck:strict` clean; `npm test` → **all tests pass** including the new `access_guard.test.mjs`; `wrangler deploy --dry-run` succeeds with only the pre-existing informational `[WARNING] "unsafe" fields are experimental` (RL_HOST / RL_AI rate-limiter bindings — config-level, not a code bug). `npm run lint` not exercised — `eslint` is not installed in this environment (pre-existing infra gap). |

## Surgical fix bonus
| File | Note |
|------|------|
| `apps/worker/src/news/enrich.ts:230` | `idx.query(..., { returnMetadata: true })` was rejected by tsc (`true` ⊄ `"all" \| "none" \| "indexed"`). Changed to `"all"`. Pre-existing typecheck failure, surfaced because this pass requires a clean `typecheck`. |

## Public route allow-list (canonical)
The CI test `test/access_guard.test.mjs` enforces this list. Any change
here must update both that test's `PUBLIC_ALLOW_LIST` / `PUBLIC_PREFIX_ALLOW_LIST`
constants and this table.

| Path | Why public | Auth substitute |
|------|------------|-----------------|
| `/health` | Cheap liveness probe; not under `/api/*` | None — DB ping only, no PII |
| `/api/health` | Health/readiness probe under `/api/*` namespace | None — DB ping only, no PII |
| `/api/webhooks/*` (currently `/api/webhooks/campaigns`) | Inbound HMAC-signed events from marketing / third-party tools that can't carry a Cloudflare Access cookie | Per-subapp HMAC signature verification |
| `/api/compute/*` (`register-exchange`, `heartbeat`, `pull`, `complete`) | External compute-pool runners (non-browser clients) that cannot carry a Cloudflare Access cookie | Per-node HMAC envelope (`src/services/compute/envelope.ts`); the registration exchange consumes a one-time admin-minted token |

## Breaking-change callout (Task #6 fix)
Relocating the marketing webhook from `/api/campaigns/:id/webhook`
to `/api/webhooks/campaigns/:id/webhook` is a URL change. Any
configured upstream webhook URLs in third-party tools must be updated.
Logged here so the migration is visible to operators; this is the
unavoidable consequence of aligning to the spec's `/api/webhooks/*`
public-namespace policy.

## Follow-ups
None proposed via `proposeFollowUpTasks` — Task #4 ("Fix Critical Bugs
Blocking Migrations & Routes") already depends on this task and absorbs
the deferred migration-order FK / ON-CONFLICT audit work (items #2 and
#3 above).

## Platform audit pass (2026-09)

Findings confirmed by reading both sides of each code path, fixed with a
regression test each. Listed newest-first; every item shipped in one branch.

| Area | Defect | Failure it caused | Fix |
|---|---|---|---|
| `routes/compute.ts`, `services/compute/dispatcher.ts` | `last_heartbeat_at` / `deadline_at` written with SQLite `datetime('now')` (space-separated) but compared against a JS ISO cutoff (`T`-separated). D1 compares TEXT bytewise and `' ' < 'T'`. | Every registered compute node was disabled with `heartbeat_timeout` on its *next* heartbeat and its open assignments flipped to `reassigned`; elapsed deadlines were invisible until the UTC date rolled over. | Bind ISO on both sides. `src/services/compute/__tests__/watchdog.test.mjs` asserts neither file uses `datetime('now')` for these columns. |
| `middleware/pagination.ts` (new) | ~30 list routes clamped only the upper bound of `limit`/`offset`. SQLite treats a negative LIMIT as unbounded; `Number("abc")` → NaN → bound as NULL. | `?limit=-1` dumped whole tables (`error_log`, `jobs`, `documents`); `?offset=abc` returned a 500. | One `/api/*` middleware rejects non-integer / out-of-range pagination with a 400. `test/pagination_guard.test.mjs`. |
| `routes/{firms,investors,people,leads}.ts` | Sort whitelists were plain object literals, so `?sort_by=constructor` resolved to an inherited function. | Whitelist failed *open* into `ORDER BY function Object() …` → SQL syntax error → 500. | Prototype-free maps (`Object.create(null)`). |
| `scheduled.ts` (nightly) | The persona-match sweep re-threw `migration_order_stub_active` out of its catch. The chain runs inside `ctx.waitUntil`, so the throw never failed the cron tick. | The ~17 sweeps after it (fund refresh … project match) silently never ran. | Log the SLO violation and continue. `test/error_surfacing.test.mjs` forbids any rethrow in the nightly chain. |
| `scheduled.ts` (6-hourly) | Two candidate `SELECT`s ran outside any try/catch *and* outside `waitUntil`. | One D1 error rejected `scheduled()` and skipped all three 6-hourly sweeps. | Both wrapped; failures land in `error_log`. |
| `scheduled.ts` (cron panel) | Only 2 of the 5 cron slots called `markCronTick`. | `/ops/system-health/` showed three crons as never having run. | All five marked; a test derives the list from `wrangler.toml`. |
| `services/systemHealth/alerts.ts` | `node_down` skipped every `enabled = 0` node, but the watchdog disables at 90 s and the alert needs 5 min. | The `node_down` alert could never fire. | Exempt only admin-parked nodes (`last_error !== 'heartbeat_timeout'`). |
| `services/systemHealth/collectors.ts` | Queue depth counted `status IN ('pending','running')`; the jobs table never writes `pending`. | Depth read ~0 against any backlog, so `queue_age` could never fire; `failed_24h` ignored `dead_letter`/`timed_out`. | Count `queued`/`running` and all three terminal failure states. |
| `scraper/pipeline.ts` | The executor promise was left unobserved when the deadline won the race. | Unhandled rejection in the Worker whenever a timed-out job later failed. | Attach a no-op catch alongside the race. |
| `routes/admin.ts` | `sweepStuckJobs` selected every `running` job with no LIMIT, at the head of every queue batch. | After an outage the sweep could spend the batch's whole subrequest budget, failing every message in it. | `ORDER BY running_started_at ASC LIMIT 200`; the hourly cron drains the rest. |
| `entities/facts.ts` | The override lock check used `.catch()` on a promise, which cannot catch a synchronous `prepare()` throw. | A missing `field_overrides` table failed the whole fact write instead of degrading to "no lock". | Wrapped in try/catch. |
| `apps/site` (all dashboard JS) + `middleware/simple_request.ts` (new) | 145 call sites used bare `fetch` with a JSON content-type, a custom header, or a PUT/PATCH/DELETE — each triggers a CORS preflight that Cloudflare Access answers with a login redirect. | Every authenticated write from the dashboard failed in production. | All calls routed through `adsUtil.request`, which emits a CORS-simple request; the Worker reverses the tunnel before routing. Two tests, including a guard that fails if any bare `fetch(` reappears in dashboard code. |
