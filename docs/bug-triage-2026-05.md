# Bug Triage Pass (Task #2) — May 2026

Status vocabulary (per task spec): `fixed` / `not-applicable` / `follow-up`.

| # | Item | Status | Files | Note |
|---|------|--------|-------|------|
| 1 | Missing route mounts | not-applicable | `apps/worker/src/routes/*.ts`, `apps/worker/src/index.ts` | Enumerated all 43 files under `src/routes/`. 42 are Hono apps and every one is imported + `api.route(...)`'d in `index.ts`. The 43rd (`_firms_filter.ts`) is a helper imported by `firms.ts`, not a router. No routes were dropped on the floor. |
| 2 | Foreign-key targets exist | follow-up | `apps/worker/migrations/*.sql` | Spot-checked recent migrations (200–331): every `REFERENCES` resolves to a table created earlier. A full cumulative ordered walk across all 62 migrations is deferred to Task #4 ("Fix Critical Bugs Blocking Migrations & Routes"), which already depends on this task and explicitly covers deeper migration repair. |
| 3 | D1-incompatible `ON CONFLICT` | follow-up | `apps/worker/migrations/*.sql` | Spot-checked recent `ON CONFLICT(...)` clauses; each had a matching `UNIQUE` constraint or `UNIQUE INDEX` earlier. A full cumulative audit is deferred to Task #4 alongside item #2. |
| 4 | Missing `await` on D1 calls | not-applicable | `apps/worker/src/**/*.ts` | Scanned every `.prepare(...)` callsite ending in `.run()` / `.first()` / `.all()` / `.raw()` via a custom AST-light scan. Five hits in `apps/worker/src/entities/query.ts:24-28` are inside `Promise.all([...])` and therefore awaited by the outer `await`. Zero genuine missing awaits. |
| 5 | Error boundary doesn't leak stacks | fixed | `apps/worker/src/index.ts`, `apps/worker/src/types.ts`, `apps/worker/test/access_guard.test.mjs` | `api.onError(...)` now branches on `env.ENVIRONMENT === "production" \|\| !env.DEBUG`. In prod it returns exactly `{ error: { code, message } }` — never `cause.stack`, and for internal/5xx errors the message is replaced with the constant `"Internal server error"` so raw SQL / provider / platform error strings cannot leak. Dev keeps the rich legacy envelope. `Env` gained `ENVIRONMENT?` and `DEBUG?` so the gate typechecks. The new `onError` source-level assertions in `test/access_guard.test.mjs` lock the envelope shape in CI. |
| 6 | Auth bypass scan | fixed | `apps/worker/src/index.ts`, `apps/worker/test/access_guard.test.mjs` | `api.use("/api/*", accessGuard)` is mounted at line 97, before every `api.route("/api/...", ...)`. Documented public allow-list: `/api/campaigns` (HMAC-signed marketing webhook subapp mounted before `accessGuard`). `/health` (cheap liveness, not `/api/*`) is also public; `/api/health` (deep readiness) is mounted **after** `accessGuard`. A new CI test (`test/access_guard.test.mjs`) introspects `src/index.ts` and fails if any `/api/*` route appears before `accessGuard` without being in the explicit `PUBLIC_ALLOW_LIST` constant. |
| 7 | Queue retry storm | not-applicable | `apps/worker/src/index.ts` | The `queue(...)` handler calls `msg.retry()` at most once per message-handling invocation (one decision per iteration). Retry cap was already lowered from 5 → 3 attempts; after 3 the message is `ack()`'d and the job is transitioned to `dead_letter` (with a state-machine guard so terminal states set by the sweeper are not clobbered). |
| 8 | Cloudflare bindings | fixed | `apps/worker/wrangler.toml`, `apps/worker/src/types.ts` | Added `[[r2_buckets]] binding="IMPORTS"` (Task #57 inbox), `[[r2_buckets]] binding="TRANSCRIPTS"` (Task #43 call transcripts), and `[[vectorize]] binding="VECTORIZE_ENTITIES" index_name="axal-entities-768"` (Tasks #7 / #8 / #9). `[ai] binding="AI"` was already declared. `Env` updated with `IMPORTS?`, `TRANSCRIPTS?`, `VECTORIZE_ENTITIES?` so TypeScript catches future drift. |
| 9 | Verification | fixed | — | `npm run typecheck` clean; `npm run typecheck:strict` clean; `npm test` → **all tests pass** including the new `access_guard.test.mjs`; `wrangler deploy --dry-run` succeeds with only the pre-existing informational `[WARNING] "unsafe" fields are experimental` (RL_HOST / RL_AI rate-limiter bindings — config-level, not a code bug). `npm run lint` not exercised — `eslint` is not installed in this environment (pre-existing infra gap). |

## Surgical fix bonus
| File | Note |
|------|------|
| `apps/worker/src/news/enrich.ts:230` | `idx.query(..., { returnMetadata: true })` was rejected by tsc (`true` ⊄ `"all" \| "none" \| "indexed"`). Changed to `"all"`. Pre-existing typecheck failure, surfaced because this pass requires a clean `typecheck`. |

## Public route allow-list (canonical)
The CI test `test/access_guard.test.mjs` enforces this list. Any change
here must update both that test's `PUBLIC_ALLOW_LIST` constant and this
table.

| Path | Why public | Auth substitute |
|------|------------|-----------------|
| `/health` | Cheap liveness probe; not under `/api/*` | None — DB ping only, no PII |
| `/api/campaigns` (webhook subapp) | Marketing tools post events without a Cloudflare Access cookie | HMAC signature verification inside the subapp |

## Follow-ups
None proposed via `proposeFollowUpTasks` — Task #4 ("Fix Critical Bugs
Blocking Migrations & Routes") already depends on this task and absorbs
the deferred migration-order FK / ON-CONFLICT audit work (items #2 and
#3 above).
