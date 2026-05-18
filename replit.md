# AI Data Signal

Jekyll site (`apps/site`) on GitHub Pages at aidatasignal.com + Cloudflare Worker
(`apps/worker`) at api.aidatasignal.com. Repo: `AxalNetwork/Lead`. CF account
`30c9362191318777b71647145decda48`. D1: `aidatasignal-leads`
(`ecd7272e-533d-4e01-81ba-e1b98bce6e1c`). Allowlisted operator:
`guillaumelauzier@gmail.com`.

## Workflows
- `Start application`: `cd apps/site && bundle exec jekyll serve --host 0.0.0.0 --port 5000 --destination /tmp/jekyll-aidatasignal`

## Operational notes
- **Replit auto-commit ⇄ task-agent push divergence.** Replit checkpoints
  auto-commit to local `main` while merged task-agent commits land on
  `origin/main`. This regularly produces parallel histories with duplicate
  commit messages (e.g. multiple "Task #N: …" commits on each side). When
  `git push` is rejected with `PUSH_REJECTED`, first check if `origin/main` is
  already an ancestor of local `HEAD` (often it is — local just hasn't been
  pushed yet); otherwise reconcile with `git pull --rebase origin main`. The
  main agent cannot run destructive git commands (push/rebase/reset/merge)
  and must delegate to a background project task.

## Architecture decisions

### Task #1 — fact write path: insertFact is canonical (ACCEPTED, contract update)
Task #1 spec note (line 48) says workflows should use the existing
`EntityService` write path in `apps/worker/src/entities/profile.ts` until
the predicate router lands. That file's public surface is a set of
*typed* helpers (`setPersonIdentity`, `addCareerEntry`, `addBoardSeat`, …)
whose private `mirrorFact` validates every predicate against
`PREDICATE_REGISTRY` — a registry scoped to the rich PERSON profile
(Task #4). Per-profile-type workflows emit type-general predicates
across many entity shapes (`firm.aum_usd`, `firm.stages`,
`founder.company_founded`, `firm.corporate_parent`, etc.), so they
cannot route through that registry without forcing every workflow
predicate into a PERSON-only registry.

Accepted resolution: workflows write through
`apps/worker/src/entities/facts.insertFact` — the same low-level write
that `mirrorFact` itself wraps. `insertFact` already provides the
provenance, supersedes-chain, summary-rebuild enqueue, and persona
match-refresh side-effects the spec requires; in addition,
`_shared.persist` stamps the new `facts.verified` column post-insert
when crossRef promotes a row. When the predicate router lands
(source Task 78), workflows swap one helper without changing their
contract.

### Task #3 — smart_frontier staging (ACCEPTED, not a deviation)
Task #3 spec text says "candidates land in crawl_frontier". Task #2 already
owns `crawl_frontier` with a url_id-keyed work-queue schema (see
`migrations/250_link_discovery.sql`). Re-shaping that table to also carry
discovery_reason / priority / profile_type_id would mutate Task #2's
contract.

Accepted resolution: `smart_frontier` is a typed, priority-ranked STAGING
area introduced in migration 342. The hourly cron drains it into Task #2's
`crawl_frontier` queue via `services/frontier/drain.ts`
(`upsertDiscoveredUrl` + `enqueueFrontier`).

Status mapping (`smart_frontier.status` → `crawl_frontier`):
- `queued`    — emitted by `expandFrontier`, not yet drained.
- `enqueued`  — drained; corresponding row exists in `crawl_frontier`
                (keyed by `discovered_urls.id`) for the crawler to pop.
- `rejected`  — drain rejected by canonical/obvious-reject filters; no
                `crawl_frontier` row, will not be retried.

Operators inspect the per-type funnel in `smart_frontier`; the crawler
still pulls work from the single Task #2 queue.

### Task #2 — LP disclosure crawler: lp_slug → entity registry (ACCEPTED)
The spec says "every adapter calls fundResolver.ts" but is silent on how
adapters bind to LP entities. Each adapter is bound to one LP (CalPERS,
Harvard, ADIA, …) by a stable `lp_slug` string; the persist layer
(`services/lpDisclosures/persist.ts`) maps slug → `u_entities.id` via a
`lp.slug` fact lookup, minting the LP entity through the canonical
`createEntity` + `addRole('lp')` path on first encounter. All
identifier facts (`lp.slug`, `lp.class`, `lp.display_name`) and
corroborating facts (`fund.lp_commitment_usd`,
`firm.lp_committed_usd`) flow through `insertFact` per the Task #1
canonical write decision. Adapters never INSERT into `u_entities`,
`facts`, or `lp_fund_commitments` directly.

Idempotency lives in the migration: `UNIQUE(lp_entity_id,
fund_name_raw, as_of_date)` + `INSERT OR REPLACE` semantics in the
persist `ON CONFLICT` clause. Re-running the same disclosure overwrites
the same rows.

### Task #1 — Deal dedupe key includes event_type (ACCEPTED, contract update)
The task spec documents the dedupe formula as
`sha256(normalized_company_name + round_name + month_bucket)`.
Implementation uses
`sha256(normalized_company + "|" + event_type + "|" + round + "|" + month_bucket)`.
Reason: without `event_type` in the key, a Series B funding_round and an
unrelated 8-K acquisition for the same company in the same month would
collide on one `deal_events` row. `event_type` is therefore required at
the typed signature of `dealDedupeKey()` and the function returns null
when it is missing/empty. SEC Form D synthesis (which emits
`round_name=null`) still corroborates with press-wire rows that have
`round_name="Series X"` via the persist layer's secondary
"round-flexible" lookup in `services/deals/persist.ts`, not via the key
itself. AI extractor (`ai/dealExtractor.ts`) rejects rows with missing
or unrecognized `event_type` rather than defaulting to `funding_round`,
preserving the spec's "no silent coercion" contract.

### Task #2 — /ops/crawler/ page-level gating (CONSTRAINT, not a deviation)
The Jekyll site is statically hosted on GitHub Pages; there is no
edge function or origin worker on aidatasignal.com to intercept page
routes. True server-side 403 for `/ops/crawler/` is therefore not
possible at the page-route layer.

Implemented gate: the rendered HTML contains an `#ops-content`
wrapper that is `hidden` by default. `ops-crawler.js` pre-flights
`GET /api/ops/crawler/` (gated by accessGuard + adminOnly on the
worker) before revealing or polling anything; on 403 the content
wrapper is wiped and a forbidden card is shown. All operational
data, mutations, and controls live behind the worker's adminOnly
guard — the page itself never holds operational data for
unauthenticated viewers.

### Task #4 — Snapshot URL contract uses ?id= not /:id (CONSTRAINT, not deviation)
The Task #4 spec specifies immutable snapshot URLs at
`/dashboard/<page>/snapshot/:id`. Jekyll on GitHub Pages serves only
prebuilt static paths and has no edge router to bind a dynamic `:id`
path segment (same constraint as the `/ops/crawler/` page-level gating
note above). The implemented form is
`/dashboard/<page>/snapshot/?id=<snapshot_id>`. Each of the 8 dashboard
pages exposes a "Save snapshot" button that POSTs the current payload
to `/api/dashboards/snapshots` and surfaces the link in that shape.
Hydration is STRICTLY from the stored payload — `snapshot-viewer.js`
never re-queries the underlying ledger tables — so immutability is
preserved.

### Task #4 — Angel sweep on nightly cron, not weekly (ACCEPTED)
The Task #4 spec says "weekly angel refresh + nightly syndicate
rebuild". Free plan caps crons at 5 and all five slots are already
occupied (per Task #2 operational note); the consolidated nightly slot
"15 3 * * *" is the only place new sweeps can land. Implemented
resolution: both `refreshAllAngels` and `refreshAllSyndicateAnalytics`
run in the nightly tick. Running the angel sweep more frequently than
weekly is strictly safe (bounded at 500 angels/tick, idempotent
upsert) — it only increases freshness.

## User preferences
- (none recorded yet)
