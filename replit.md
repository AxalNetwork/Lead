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

### Task #4 — dashboards_pdf.ts IS the canonical PDF path (ACCEPTED)
The Task #4 spec asks PDF exports to "go through the existing
report-renderer pipeline." A repo-wide audit
(`rg "application/pdf|generate.*pdf|pdf.*render" apps/worker/src/`)
found no shared report-renderer service — the only existing PDF code
is `imports/pdf_parser.ts` / `scraper/parsers/pdf.ts` (PDF *parsing*,
input direction) and `projects/pitch.ts` (notes on PDF text
extraction). There is no PDF *render* pipeline to route through.

Accepted resolution: `routes/dashboards_pdf.ts` (handwritten PDF 1.4,
Helvetica, accurate xref offsets, X-Total-Rows parity header) IS the
canonical product PDF path going forward. All 11 dashboard endpoints
plus `/kpi.pdf` go through `pdfResponse()`; any future product feature
that needs PDF output (digest exports, reports, etc.) should import
`buildPdf` / `pdfResponse` from this module rather than spawning a
parallel implementation.

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

### Task #13 — Document intelligence: migration 361 + source_kind="import" for document facts (ACCEPTED)
The Task #13 spec slots above #14 in the queue but migrations 358/359/360
were already taken when the work landed, so the documents migration is
`apps/worker/migrations/361_documents.sql` (4 tables: `documents`,
`document_extractions`, `document_data_rooms`, `data_room_documents`).
Subsequent migrations should number from 362.

Derived business facts mirrored from extractors
(`safe.cap_usd`, `deal_terms.pre_money_usd`, `commercial.acv_usd`, …)
flow through `insertFact` per the Task #1 canonical write contract,
with `source_kind="import"` (the existing enum value that best matches
operator-uploaded artifacts — there is no dedicated "document" kind).
The `source` field carries the extractor name
(`document:safeParser`, `document:termSheetParser`, …) and
`evidence_url` is `r2://documents/<id>/<filename>`.

Document processing is **inline** in `POST /api/documents/upload`
rather than queued via JobKind: the existing job system has no
`document_extract` kind, and uploads are bounded at 50 MB so inline
extraction fits within Workers' CPU budget for the supported text
formats (PDF via pdfjs-dist, XLSX via the xlsx package, plain
text/HTML). PII redaction is **default on** (regex pass for email
/ SSN / ITIN / US bank / IBAN / phone / Luhn-checked credit-card);
the per-document `allow_raw_text` flag bypasses redaction and is
audit-logged at `console.log({event:"document.allow_raw_text",…})`.

Per the Task #4 static-routing constraint, the data-room detail
page lives at `/dashboard/data-rooms/?id=<room_id>` (query string
rather than path segment) and hydrates strictly from
`GET /api/data-rooms/:id/index`.

### Task #14 — Background verification + reference network (ACCEPTED)
Spec slotted migration 358 but 358/359/360/361 were already taken
(Task #4 alert kinds / Task #5 cap tables / Task #9 valuation /
Task #13 documents). The schema lands at
`apps/worker/migrations/362_background_verification.sql`; future
migrations should number from 363.

`verification_findings` is STRICTLY append-only with the Task #1
supersedes-chain: re-runs that change `status` insert a new
`is_current=1` row and mark the prior one
`is_current=0, superseded_by=<new_id>`. Re-runs with the same status
write NO row and do not mutate existing rows — the prior `created_at`
is the durable "first observed" timestamp; freshness is tracked on
`person_verification_state.last_verified_at` instead. Derived business facts
(`person.education.verified`, `person.prior_startup.outcome`,
`person.litigation.federal_hits`, `person.board_seat.verified`) flow
through `insertFact` with `source_kind="enrichment"` and
`source="verifier:<name>"` per the Task #1 canonical write contract.

Public-records fetchers are honest about what they can prove:
CourtListener emits `unverifiable` (reason `courtlistener_unconfigured`)
when `COURTLISTENER_TOKEN` is absent — never silently `confirmed`.
PACER is stubbed as `unverifiable` (reason `pacer_client_not_implemented`)
even with credentials set; the real PCL flow lands in a follow-up.
Education verifier requires both a known commencement-page URL AND
a person display name from `u_entities`; absent either, it returns
`unverifiable` rather than guessing.

Admin gating on `POST /api/persons/:id/verify` uses `c.var.is_admin`
populated by the existing `accessGuard` middleware
(`src/middleware/access.ts`, NOT a separate `accessGuard.ts`) rather
than a parallel `adminOnly` middleware — there is no shared
admin-only middleware in this worker yet, and this matches the
inline-admin-check pattern used by the dashboards / ops routes.

Optional source tables (`sec_form4_insiders`, `firm_team_snapshots`,
`entity_mentions`, `sec_director_filings`, `publication_authors`,
`conference_attendees`, `accelerator_batches`, `deal_events`) are
wrapped in try/catch in both runner and reference builder so the
modules degrade gracefully when a particular source isn't populated
in a given environment (test DBs, fresh installs). This is
intentional and not a silent fallback — missing-source paths return
`unverifiable` or simply skip a pass; verified data never depends on
swallowed errors.

Nightly sweep piggybacks the consolidated `15 3 * * *` slot (Free
plan caps crons at 5/5 — same constraint as the Task #4 angel-sweep
note above). Bounded at 200 persons/tick. Sweep criterion:
`last_verified_at IS NULL` OR viewed in last 30 days OR last
verified >7 days ago. Reference-network rebuild runs in the same
tick for the persons just verified.

Per the Task #4 static-routing constraint, the Profile verification
tab lives at `/dashboard/verification/?id=<entity_id>` (query string,
not path segment).

### Task #18 — Term-sheet intelligence: migration 365 + source_kind="filing"/"import" for preferred-series facts (ACCEPTED)
Spec said the schema lands at migration 351, but 351-364 are all
taken (per Task #13/#14 contract-update notes above). The
preferred-stack schema lands at `apps/worker/migrations/365_preferred_stack.sql`
(`preferred_series`, `preferred_series_investors`, `term_benchmarks`).
Future migrations should number from 366.

Per the Task #1 canonical write contract, every derived per-term fact
(`preferred.<series>.lp_x`, `preferred.<series>.participating`,
`preferred.<series>.anti_dilution`, …) flows through `insertFact`
with `source_kind` set to the existing enum value that best matches
the origin: `"filing"` for SEC S-1 / 8-K Item 3.03 extractions and
`"import"` for operator-uploaded term sheets / Delaware COI fetches.
There is no dedicated `"charter"` or `"term_sheet"` source_kind —
the existing enum already covers the provenance distinction and
adding new values would force a registry change in the rich PERSON
profile path.

`preferred_series` is append-only with a Task #14-style supersedes
chain: re-extraction (or 8-K Item 3.03 charter amendment) that
changes material terms inserts a new `is_current=1` row and marks
the prior one `is_current=0, superseded_by=<new_id>`. Re-runs with
identical terms are no-ops — the prior row's `created_at` is the
durable "first observed" timestamp.

Investor attribution into `preferred_series_investors` uses
`resolveSecEntity({ createIfMissing: false })` — raw investor strings
scraped from charter sections must NOT mint fresh `u_entities` rows
(name regex on legal-prose carries too many false positives).
Unresolved raw names are preserved on the parent series row's
`payload_json` for forensic review and lift into the relational
table only after they're cross-referenced via SEC ADV / Form D /
the operator-assisted entity merger.

Delaware COI fetcher (`services/termSheets/delawareCoi.ts`) and
press/Twitter leak harvester (`services/termSheets/leakHarvester.ts`)
follow the Task #14 PACER honesty pattern: when the required env
vars (`DELAWARE_COI_API_URL` / `DELAWARE_COI_API_KEY`, or
`TWITTER_BEARER` / `PRESS_LEAK_FEED_URL`) are absent they return
a documented `unconfigured` status — never a silent fallthrough or
a fake `confirmed`. Leak rows carry `source='press_leak'` and
parser-clamped `confidence≤0.5` so operators can filter them out of
benchmark inputs until promoted.

Nightly `rebuildTermBenchmarks` piggybacks the consolidated
`15 3 * * *` slot (Free plan caps crons at 5/5 — same constraint as
Task #4 angel sweep and Task #14 verification sweep). Buckets with
fewer than 5 rows still get a `term_benchmarks` row but with
`payload_json.low_sample=true` so the route handler can surface the
low-confidence flag in the UI.

Per the Task #4 static-routing constraint, the preferred-stack
panel hydrates from `/dashboard/companies/detail/?id=<entity_id>`
(query string, not path segment) and the term-aggressiveness widget
from `/dashboard/investors/detail/?id=<entity_id>`.

### Task #2 — Fund-Return Modeling: migration 366 + source_kind="inferred" for modeled fund facts (ACCEPTED)
Spec slotted the schema at migration 352, but slots 350–365 are all
taken (per the Task #13/#14/#18 contract-update precedent above).
The model schema lands at `apps/worker/migrations/366_fund_returns.sql`
(two tables: `fund_return_models` append-only per-run, and
`fund_return_calibration` per-(vintage, strategy) bias bucket).
Future migrations should number from 367.

Per the Task #1 canonical write contract, every modeled fund-level
fact (`fund.dpi`, `fund.tvpi`, `fund.moic`, `fund.net_irr_pct`,
`fund.return_confidence`) flows through `insertFact` with
`source_kind="inferred"` — the existing enum value that best matches
model output. There is no dedicated `"model"` source_kind; adding
one would force a registry change in the rich PERSON profile path.
The `source` field is the literal string `"fund_return_model"` and
`evidence_url` is null (model output, not a scraped page).

Invested capital is the **sum of fund checks**
(`deal_participants.position_usd`), NOT the sum of round sizes. The
portfolio builder threads check size onto `PortfolioRow.position_usd`
alongside the round-level `amount_usd`. Positions without a disclosed
check size (Form D rows — Form D reports the round total, not the GP's
contribution; and deal rows where the participant row had no
`position_usd`) contribute 0 to invested and emit a per-position
`pos:<company>:no_check_size` warning so operators see the gap rather
than silent capital inflation. Ownership is `check ÷ round_size` when
both are known, falling back to `check ÷ last_mark_valuation` only when
the round size is missing.

Nightly sweep models EVERY eligible fund each night
(active | harvesting | wound_down). Rotation is oldest-modeled-first
via `LEFT JOIN fund_return_models` on `MAX(as_of)` so that if the
ceiling is ever hit, the funds most overdue for a refresh are
processed first. A same-day filter
(`m.last_as_of IS NULL OR m.last_as_of < today`) ensures a single
tick never re-processes a fund it already modeled. The hard safety
ceiling is 5000 funds/tick — comfortably above the present platform
population and well within the Workers cron CPU budget at ~50ms/fund.

Per-company proceeds estimator (`services/fundReturns/proceeds.ts`)
is a pure module: no DB access, accepts pre-fetched exit signals so
it can be unit-tested in isolation. Exit-event classifier in
`services/fundReturns/model.ts::fetchExitSignal` reads
`deal_events.event_type IN ('ipo','acquisition','merger','bankruptcy')`
as the primary signal; falls back to the latest `valuation_marks` row
for unexited residual. `valuation_marks` is wrapped in try/catch so
legacy test DBs without the Task #9 table degrade gracefully — the
position falls back to held-at-cost rather than throwing.

Confidence band per spec: ≥70% positions resolved → high, 40–70% →
medium, <40% → low. Only `ipo`/`acquisition`/`merger`/`bankruptcy`
count as resolved; `unexited` and unknown do not. Fee drag is
2%/yr × years since `first_close_date` × `announced_raised_usd`,
capped at 10 years. Net IRR is the simplified annualized return
((TVPI ^ (1/years)) − 1); null when fund duration < 6 months.

Calibration loop (`rebuildCalibration`) is a no-op until LP
disclosures with fund-level tvpi/dpi actuals exist in
`lp_fund_commitments` (Task #95 dependency). When sample_size < 3
in a (vintage, strategy) bucket, `lookupBiasCorrection` returns
`1.0` rather than applying a noisy correction. Bias is bounded to
[0.5, 1.5] so a small actuals sample cannot swing the modeled TVPI
more than ±50%.

Nightly sweep (`runNightlyFundReturnSweep`) piggybacks the
consolidated `15 3 * * *` slot (Free plan caps crons at 5/5 — same
constraint as Task #4 angel sweep, Task #14 verification sweep,
Task #18 term benchmarks). Paginated by `id` ASC (100 funds/page,
safety ceiling 5000/tick) so every fund with status in
(active|harvesting|wound_down) gets a fresh row each tick — not a
sample. Calibration rebuild runs in the same tick AFTER the model
sweep so the next night's run sees the freshest deltas.

Per-company exit-signal enrichment lives in pure helpers
(`services/fundReturns/exitSignal.ts`): `parseIpoExtras` pulls offer
price + share counts from `deal_events.use_of_proceeds` /
`amount_raw`, backs into retained shares via implied total
shares = valuation / offer_price, so the primary IPO formula
(ownership × (sold × offer + retained × VWAP)) activates whenever
the data is there; `parseEscrowPct` extracts holdback %; and
`sectorMedianMultiple` provides the M&A undisclosed-deal-size
fallback against a small public-trackers median table. All three
are pure (no DB) and unit-tested.

Per the Task #4 static-routing constraint, the modeled-returns UI
lives as a tab inside the new Fund profile at
`/dashboard/funds/detail/?id=<fund_id>` (Overview / Portfolio /
Modeled returns). The legacy `/dashboard/fund-returns/?id=<id>` is
preserved as a `location.replace()` redirect into the tab so existing
deep links keep working. API endpoints are
`GET /api/funds/:id/modeled-returns` (latest + history) and
`GET /api/funds/:id/modeled-returns/attribution` (top-5
contributors). The new `fundReturnsRoute` is mounted BEFORE the
existing `fundsRoute` in `src/index.ts` so the `/:id` wildcard
on the parent route doesn't shadow the new sub-paths.

### Task #3 — Edge-Quality Scoring + Power-Node Detection: migration 367 + source_kind="inferred" for influence facts (ACCEPTED)
Spec slotted the schema at migration 353, but slots 350–366 are all
taken (per the Task #13/#14/#18/#2 contract-update precedent above).
The schema lands at `apps/worker/migrations/367_edge_quality.sql`
(adds `quality_score` / `quality_signals_json` / `last_interaction_at`
to `rel_edges`; creates `entity_influence` with global PageRank,
per-sector PageRank JSON, broker score, degree counts, and
is_power_node flag). Future migrations should number from 368.

Per the Task #1 canonical write contract, every derived per-entity
influence fact (`entity.pagerank_score`, `entity.broker_score`)
flows through `insertFact` with `source_kind="inferred"` — the
existing enum value that best matches model output. There is no
dedicated `"model"` source_kind (same reasoning as the Task #2
fund-return modeling note above); adding one would force a
registry change in the rich PERSON profile path. The `source`
field is the literal string `"edge_quality_engine"`.

Quality signals (8 collectors: co-investment, public co-mentions,
board overlap, twitter reply rate, linkedin endorsements, joint
panels, same firm/school, mutual-connections Jaccard) live in
`services/edgeQuality/signals.ts`. Each collector wraps its source
query in a `safeQuery` try/catch so missing optional source tables
(`deal_participants`, `entity_mentions`, `social_interactions`,
`linkedin_endorsements`, `conference_attendees`) degrade to
absent-signal — not error — same pattern as the Task #14
verification optional-source pattern above.

PageRank + broker score are pure modules (`pagerank.ts`,
`broker.ts`) — no DB access, unit-tested on fixture graphs. The
broker score is `1 − clamp01(Burt's network constraint)` on the
undirected symmetrized graph; high = high broker. Power-node
flag is set on the top-N (N=50) per primary_sector by sector-
PageRank.

Edge scoring is paginated by `id ASC` with `EDGE_BATCH=200` per
loop iteration and a safety ceiling of 25 pages = 5000 edges/tick
(Task #2 fund-return precedent). The entity_influence rebuild
loads the full scored graph in memory; the platform population
comfortably fits today and we'll chunk by SCC if/when it grows
past that bound.

**Dual-graph constraint** (CONSTRAINT, not deviation): two graph
tables exist — `rel_edges` (Task #4 unified, TEXT entity ids) is
the spec's target; the legacy `relationships` (INTEGER ids,
migration 19) is what the existing Profile relationship graph
UI (`apps/site/assets/js/relationship-graph.js`) reads via
`GET /api/relationships/entity/:id`. The new endpoints
(`/api/entities/:id/relationships`, `/api/entities/:id/influence`,
`/api/power-nodes`) operate on `rel_edges` per the spec. The
UI overlay overlays `quality_score` onto the existing graph by
fetching the new endpoint in parallel and matching edges by
`(src_entity_id, dst_entity_id, kind)` via the entity ↔ legacy
mapping; the legacy endpoint shape is preserved.

Sweep piggybacks the consolidated `15 3 * * *` slot (Free plan
caps crons at 5/5 — same constraint as Task #4 angel sweep,
Task #14 verification sweep, Task #18 term benchmarks, Task #2
fund-return sweep). Runs AFTER the existing relationship
derivation step so freshly-derived edges get scored in the same
tick.

## User preferences
- (none recorded yet)
