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

## User preferences
- (none recorded yet)
