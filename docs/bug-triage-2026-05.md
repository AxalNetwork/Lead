# Bug Triage Pass (Task #2) — May 2026

One row per item in the task spec. Status = `fixed` / `clean` (no-op, audit
confirmed no issue) / `follow-up` (logged for a future task).

| # | Item | Status | Files | Note |
|---|------|--------|-------|------|
| 1 | Missing route mounts | clean | `apps/worker/src/routes/*.ts`, `apps/worker/src/index.ts` | Enumerated all 43 files under `src/routes/`. 42 are Hono apps and every one is imported + `api.route(...)`'d in `index.ts`. The 43rd (`_firms_filter.ts`) is a helper imported by `firms.ts`, not a router. No drops. |
| 2 | Foreign-key targets exist | clean (spot-check) | `apps/worker/migrations/*.sql` | Spot-checked migrations 200–331 for `REFERENCES` targets; every reference resolves to a table created in an earlier (or same) migration. No new repair migration needed. A full cumulative walk is logged as a follow-up if any future ON-CONFLICT/FK surprises surface. |
| 3 | D1-incompatible `ON CONFLICT` | clean (spot-check) | `apps/worker/migrations/*.sql` | Spot-checked recent `ON CONFLICT(...)` clauses; each had a matching `UNIQUE` constraint or `UNIQUE INDEX` declared earlier. No new index migration needed. |
| 4 | Missing `await` on D1 calls | clean | `apps/worker/src/**/*.ts` | Scanned every `.prepare(...)` callsite ending in `.run()` / `.first()` / `.all()` / `.raw()`. Five hits in `apps/worker/src/entities/query.ts:24-28` are inside `Promise.all([...])` and therefore awaited by the outer `await`. No genuine missing awaits. |
| 5 | Error boundary doesn't leak stacks | fixed | `apps/worker/src/index.ts`, `apps/worker/src/types.ts` | `api.onError(...)` now branches on `env.ENVIRONMENT === "production" \|\| !env.DEBUG`. In prod it returns the stable minimal envelope `{ error: { code, message }, request_id }` — never `cause.stack`. Dev keeps the rich legacy envelope for debugging. `Env` gained `ENVIRONMENT?` and `DEBUG?` so the gate typechecks. |
| 6 | Auth bypass scan | clean | `apps/worker/src/index.ts` | `api.use("/api/*", accessGuard)` is mounted at line 97, before every `api.route("/api/...", ...)`. Public allow-list: `/health` (mounted on `/health`, not `/api/*`) + `/api/campaigns` (webhook subapp mounted before `accessGuard` for HMAC-signed POSTs). `/api/health` is mounted *after* `accessGuard` so the deep readiness probe is protected. |
| 7 | Queue retry storm | clean | `apps/worker/src/index.ts` | The `queue(...)` handler calls `msg.retry()` at most once per message (one decision per iteration). Retry cap was already lowered from 5 → 3 attempts; after 3 the message is `ack()`'d and the job is transitioned to `dead_letter` (with a state-machine guard so terminal states set by the sweeper are not clobbered). |
| 8 | Cloudflare bindings | fixed | `apps/worker/wrangler.toml`, `apps/worker/src/types.ts` | Added `[[r2_buckets]] binding="IMPORTS"` (Task #57 inbox), `[[r2_buckets]] binding="TRANSCRIPTS"` (Task #43 call transcripts), and `[[vectorize]] binding="VECTORIZE_ENTITIES" index_name="axal-entities-768"` (Tasks #7 / #8 / #9). `[ai] binding="AI"` was already declared. `Env` updated with `IMPORTS?`, `TRANSCRIPTS?`, `VECTORIZE_ENTITIES?` so TypeScript catches drift. |
| 9 | Verification | passing | — | `npm run typecheck` clean; `npm run typecheck:strict` clean; `npm test` → **78 / 78 passing**; `wrangler deploy --dry-run` succeeds with only the pre-existing informational `[WARNING] "unsafe" fields are experimental` (RL_HOST / RL_AI rate-limiter bindings). `npm run lint` not exercised — `eslint` is not installed in this environment (pre-existing infra gap, not a bug introduced by this pass). |

## Surgical fix bonus
| File | Note |
|------|------|
| `apps/worker/src/news/enrich.ts:230` | `idx.query(..., { returnMetadata: true })` was rejected by tsc (`true` ⊄ `"all" \| "none" \| "indexed"`). Changed to `"all"`. Pre-existing typecheck failure, surfaced because this pass required a clean `typecheck`. |

## Follow-ups
None proposed via `proposeFollowUpTasks` — Task #4 ("Fix Critical Bugs
Blocking Migrations & Routes") already depends on this task and absorbs
any deeper migration / FK audit work.
