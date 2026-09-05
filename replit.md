# AI Data Signal

Jekyll site (`apps/site`) on GitHub Pages at aidatasignal.com + Cloudflare Worker
(`apps/worker`) at api.aidatasignal.com. Repo: `AxalNetwork/Lead`. CF account
`30c9362191318777b71647145decda48`. D1: `aidatasignal-leads`
(`ecd7272e-533d-4e01-81ba-e1b98bce6e1c`). Allowlisted operator:
`guillaumelauzier@gmail.com`.

## Workflows
- `Start application`: `cd apps/site && bundle exec jekyll serve --host 0.0.0.0 --port 5000 --destination /tmp/jekyll-aidatasignal`

## CI / deploy state
Two GitHub Actions workflows matter:

- **`deploy-worker.yml`** — auto-deploys the worker on every push to
  `apps/worker/**`. Gates: **typecheck** → ML-eval regression gate
  (local candidate-commit pass + remote production-drift pass) →
  resource pre-create (R2 / Vectorize / Queues / KV / AE) → D1
  migrations apply → `wrangler deploy`. **Typecheck is GREEN** — it is
  NOT the blocker.
- **`pages.yml`** — publishes `apps/site` to GitHub Pages on every push
  to `main`. **Had never succeeded** in recorded history: it carried the
  same vendored-native-gem bug as `check.yml`'s site job (see below), so
  the dashboard was not being republished by CI at all. Fixed by the same
  runner-local bundler redirect; the two blocks are kept in step.
- **`deploy-worker.yml`** — **had never succeeded** either, in any
  recorded run since 2026-06-02, which is why every worker deploy in this
  repo's history was manual. The remote ML-eval gate
  (`scripts/eval-gate.mjs`) GETs `api.aidatasignal.com` from an
  unauthenticated runner; Cloudflare Access does not answer that with
  401/403 but redirects to a login page, so the script received
  `200 text/html`, threw `SyntaxError: Unexpected token '<'` out of
  `res.json()`, and bricked the deploy after the local gate had already
  passed. The script now soft-passes a non-JSON body when no
  `GATE_API_TOKEN` is set — matching its existing 401/403-without-token
  branch, since the local candidate-commit gate is the primary defense —
  and fails hard on non-JSON when a token IS set.
  **Still blocked, one step from the end:** with that fixed the workflow
  now runs every step — resource pre-create, drift detection,
  `d1 migrations apply --remote`, and the bundle upload — and then fails
  attaching the `api.aidatasignal.com` custom-domain route:
  `A request to the Cloudflare API (/zones/…/workers/routes) failed.
  Authentication error [code: 10000]`. `CLOUDFLARE_API_TOKEN` holds the
  account scopes but not the **zone** scope
  **Zone → Workers Routes → Edit** on `aidatasignal.com`. Minting a
  replacement token and rotating the repo secret is the only fix — it
  cannot be done from the repo.
- **`check.yml`** — runs on push/PR: typecheck → **lint** → anti-pattern
  gates → **test** (`npm test`). As of the platform-audit pass this is
  **GREEN locally** (typecheck clean, lint 0 errors / warnings only,
  820+ tests passing). The historical blockers were an extensionless
  dynamic `import()` in `routes/valuation.ts` (NodeNext test build) plus
  nine stale test expectations; both are fixed. Note `npm ci` needs
  network access to `cdn.sheetjs.com` for the `xlsx` tarball.

- **`Workers Builds` (Cloudflare Git integration) is ALSO still
  connected**, despite `deploy-worker.yml`'s header saying it replaced
  it. It built and reported "Deployment successful" for feature-branch
  commits on draft PR #29. It bypasses every gate the workflow runs —
  typecheck, ML-eval gate, resource pre-create, drift detection, and
  `d1 migrations apply --remote` — so code can reach the Worker ahead of
  its migrations. Decide which path is authoritative and disable or
  restrict the other; see `docs/cloudflare-operations-checklist.md`
  section 4b. Not verifiable from a workspace without dashboard access
  to account `30c9362191318777b71647145decda48`.

**Manual deploy escape hatch** (use only with explicit user approval):
`cd apps/worker && npx wrangler@3.99.0 deploy`. This bypasses every gate
and ships whatever local commits exist, so prefer the GitHub Action.
Last manual deploy: 2026-06-09 (Version ID
`6f169ead-ba88-4eb3-84e6-25dfa0c31943`) shipping the Task #72
robots.txt/ToS-block-as-benign-skip fix at explicit user request.
Because `wrangler deploy` bundles the whole worker, this build also
carries everything merged through Task #72. Prior manual deploy was
Version ID `5d5728e5-7e8f-4ef0-a87a-46b0026f9944`, shipping the Task #68
`/api/dd/scores/by-ref` SQL-variable-overflow fix (id batch chunking);
that build carried everything merged through Task #67. Prior live
prod version was `334d2ef7-3f06-47ae-a7a2-1eb4e5ae81b1`, shipped
2026-06-09 18:25 UTC by `deploy-worker.yml` (the Task #57 push); that
build first resolved the Power Nodes "HTTP 404" by including the influence
route (`/api/power-nodes` + `/api/power-nodes/summary`, present in the tree
since 2026-05-20). `entity_influence` (migration 367) is confirmed present
in prod D1 but currently EMPTY (0 power nodes), so the page renders a 200
empty list until the nightly influence sweep populates it — that backfill
is a separate data/cron concern, not the 404.

**Prod ops WITHOUT a code deploy.** The workspace env has
`CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, so D1 migrations and
worker secrets can be applied to live prod directly — no deploy needed:
- `wrangler d1 migrations apply DB --remote` (drop any orphan object
  that stalls the chain first; a leftover `dashboard_snapshots` table
  once blocked 357→379).
- `printf '%s' "$VAL" | wrangler secret put NAME` (takes effect on the
  live worker immediately).
Worker *code* changes still require a deploy. End-to-end browser
verification of prod is NOT possible from the workspace: Cloudflare
Access 302s every `api.aidatasignal.com` request (including curl) to the
login page, so authenticated endpoints can only be confirmed in a
real operator browser session.

## Operational notes
- **Git: Replit auto-commit ⇄ task-agent push divergence.** Replit
  checkpoints auto-commit to local `main`; merged task-agent commits land
  on `origin/main`. This produces parallel histories with duplicate
  commit messages. On `PUSH_REJECTED`, first check whether `origin/main`
  is already an ancestor of local `HEAD` (it usually is — local just
  hasn't been pushed); otherwise reconcile with
  `git pull --rebase origin main`. The main agent cannot run destructive
  git commands (push/rebase/reset/merge) and must delegate to a
  background project task.
- **Cloudflare Access bounces CORS preflights on authenticated
  cross-origin requests.** A preflight `OPTIONS` carries no cookie, so
  Access 302s it to login and the browser surfaces "The string did not
  match the expected pattern" / a failed fetch. Anything that triggers a
  preflight is therefore dead in prod: a `Content-Type: application/json`
  header, a custom header (`Idempotency-Key`), or a PUT/PATCH/DELETE.
  **Systemic fix (no Zero Trust config needed):** every dashboard API
  call goes through `window.adsUtil.request(url, opts)` (or
  `adsUtil.apiFetch`) in `apps/site/assets/js/ads-utils.js`, which
  rewrites the call into a CORS *simple* request — drops the JSON
  content-type (Hono's `c.req.json()` parses the body regardless),
  tunnels PUT/PATCH/DELETE as `POST ?_method=<VERB>`, and moves
  `Idempotency-Key` to `?_idempotency_key=`. The Worker reverses the
  tunnel before routing in `apps/worker/src/middleware/simple_request.ts`
  (unit-tested in `test/simple_request.test.mjs`), so handlers still see
  the real verb/header. **Never call bare `fetch()` against the API from
  dashboard code.** The long-term alternative is the Access app setting
  "Bypass OPTIONS requests to origin" in Zero Trust, which would let the
  Worker's own `cors()` middleware answer preflights.
- **Timestamp format is load-bearing in D1.** SQLite's `datetime('now')`
  renders `2026-09-04 10:00:00` (space) while JS writes
  `2026-09-04T10:00:00.000Z` (`T`). D1 compares TEXT bytewise and
  `' ' < 'T'`, so a space-separated value sorts BELOW every ISO value of
  the same day. Mixing the two in one comparison silently inverts it —
  this disabled every compute node on its next heartbeat and hid every
  elapsed assignment deadline until the UTC date rolled over. **Write and
  compare a column in ONE format**; prefer binding
  `new Date().toISOString()` on both sides.
- **The nightly chain is one invocation.** All ~25 sweeps under
  `15 3 * * *` share a single `ctx.waitUntil`, so they share one
  subrequest and CPU budget, and a sweep that rethrows aborts every sweep
  after it — while the cron tick still reports success (the chain is
  already detached). Sweeps log and continue; never rethrow. A guard
  test in `test/error_surfacing.test.mjs` enforces this.
- **`jobs.status` vocabulary.** Producers write `queued`; the terminal
  states are `done`, `failed`, `dead_letter`, `timed_out`, `skipped`.
  There is no `pending` — querying for it silently returns nothing.
- **Dashboard asset cache-busting.** Per-page `<script>`/`<link>` tags
  append `?v={{ site.time | date: '%s' }}` so deployed JS/CSS fixes
  actually reach operators. New dashboard pages must follow this.
- **Mobile nav is a second inventory.** Below 768px the rail is hidden
  and `_includes/shell/tabbar.html` + `_includes/shell/more-sheet.html`
  take over. The sheet mirrors `shell/sidenav.html` 1:1 except for the
  two links the tab bar carries (Home, Merge Review), so **a link added
  to the rail must be added to the sheet too** or it is unreachable on a
  phone.
- **Mobile lists come from `.ads-table`, not from the page.**
  `assets/js/mobile.js` stamps every body cell with its column header as
  `data-label` and `assets/css/mobile.css` restyles that same markup as a
  card below 768px — so any list built as `<table class="ads-table">`
  with a real `<thead>` gets the card layout free, and a list rendered
  any other way gets nothing. Build lists as `.ads-table`.

## Global conventions
These durable rules are shared by every feature; later sections only
note genuine deviations.

- **Canonical fact write path.** All derived facts flow through
  `apps/worker/src/entities/facts.ts::insertFact` — NOT the typed
  `EntityService` helpers in `entities/profile.ts` (those validate
  against the PERSON-scoped `PREDICATE_REGISTRY`). `insertFact` provides
  provenance, the supersedes-chain, summary-rebuild enqueue, and persona
  match-refresh; `_shared.persist` stamps `facts.verified` post-insert
  when crossRef promotes a row.
- **`source_kind` reuse.** Never add new `source_kind` enum values
  (that would force a registry change in the rich PERSON profile path).
  Reuse the closest existing value: `inferred` (model output —
  fund-return / edge-quality / intro-routing / reputation / ML),
  `import` (operator uploads — documents, term sheets), `filing` (SEC
  extractions), `enrichment` (verifier / diligence / AI extractors). The
  `source` string carries the specific producer
  (e.g. `fund_return_model`, `verifier:<name>`, `diligence:<check_key>`).
- **Append-only + supersedes-chain.** Mutable derived tables are
  append-only: a re-run that changes material values inserts a new
  `is_current=1` row and marks the prior `is_current=0,
  superseded_by=<new_id>`. Identical re-runs are no-ops — the prior
  row's `created_at` is the durable "first observed" timestamp.
- **Honest degradation (never a silent fake).** Fetchers/collectors
  that lack their required env var/token return an explicit
  `unconfigured` / `unverifiable` status with a reason code — never a
  fabricated `confirmed`/metric. Optional source-table queries are
  wrapped in `safeQuery`/try-catch so missing tables degrade to
  absent-signal (test DBs / fresh installs), not thrown errors.
- **Entity resolution from scraped strings.** Raw names scraped from
  legal prose / charters / news route through
  `resolveSecEntity({ createIfMissing: false })` (+ domain fallback).
  Unresolved strings are DROPPED and counted, never minted into
  `u_entities` (name-regex false-positive risk).
- **Admin gating.** Use `c.var.is_admin` populated by the existing
  `accessGuard` middleware (`src/middleware/access.ts`). There is no
  parallel `adminOnly` middleware — match the inline-admin-check pattern.
  Admin ops endpoints live under `/api/ops/*`.
- **Static-routing (`?id=`) constraint.** Jekyll on GH Pages has no
  edge router, so detail/snapshot pages use query strings
  (`/dashboard/<page>/?id=<id>`), never path segments. Page-level
  "403" is impossible at the page layer; pages hide `#ops-content` and
  pre-flight the access-guarded API before revealing.
- **Snapshot URL contract.** Snapshots are
  `/dashboard/<page>/snapshot/?id=<snapshot_id>` and hydrate STRICTLY
  from the stored payload via `snapshot-viewer.js` — never re-query
  underlying tables.
- **PDF rendering.** `routes/dashboards_pdf.ts` (`buildPdf` /
  `pdfResponse`) is the one product PDF renderer. New PDF features
  import from it; no parallel pipeline.
- **Cron budget.** CF Free plan caps crons at **5/5** (all filled).
  Almost every nightly sweep piggybacks the consolidated `15 3 * * *`
  slot (each wrapped in its own try/catch, ML eval + calibration at the
  top so their failures don't block the chain). Sub-hour/health work
  piggybacks the `0 * * * *` slot. No new cron slots.
- **Route mount ordering.** New sub-path routes (e.g.
  `/funds/:id/modeled-returns`, `/entities/:id/...`) mount BEFORE the
  parent listing route whose `/:id` wildcard would otherwise shadow
  them.
- **Dual relationship graphs.** Two tables coexist: `rel_edges` (TEXT
  entity ids, the modern target for influence/quality/inference) and the
  legacy `relationships` (INTEGER ids, migration 19) that still backs the
  legacy `/api/relationships/entity/:id` + `/path` and the existing
  Profile graph UI. New endpoints operate on `rel_edges`; the legacy
  shape is preserved and new handlers mount before legacy ones.

## Migration map
Migrations are sequential and append-only. **Spec-proposed slot numbers
are ignored** — always take the next free number. Highest applied is
**380**; new migrations start at **381**.

| #   | File / feature | Key tables / columns |
|-----|----------------|----------------------|
| 342 | smart_frontier staging | priority-ranked staging; hourly drain → `crawl_frontier` |
| 361 | documents (doc intelligence) | `documents`, `document_extractions`, `document_data_rooms`, `data_room_documents` |
| 362 | background_verification | `verification_findings` (append-only), `person_verification_state` |
| 365 | preferred_stack (term sheets) | `preferred_series`, `preferred_series_investors`, `term_benchmarks` |
| 366 | fund_returns | `fund_return_models`, `fund_return_calibration` |
| 367 | edge_quality | `rel_edges` quality cols, `entity_influence` (PageRank / broker / power-node) |
| 369 | intro_routing | `intro_paths`, `intro_outcomes`, `intro_model_runs` |
| 370 | founder_crm + investor reputation | `investor_reputation`, `founder_pipelines`, `founder_pipeline_investors`, `founder_pipeline_events`, `founder_feedback` |
| 371 | diligence | `diligence_templates`, `diligence_runs`, `diligence_check_results` |
| 372 | jobs skipped status | `skipped` terminal status, `jobs.skip_reason`, `discovered_urls.tos_blocked_at` |
| 373 | dashboard_snapshots repair | trigger/schema repair |
| 374 | ml_quality_ops | `eval_datasets`, `eval_examples`, `eval_runs`, `prompt_versions`, `prediction_outcomes_calibration`, `hallucination_flags` |
| 375 | garbage_detector | `u_entities.deleted_reason`, `data_quality_log` |
| 376 | field_overrides | `field_overrides`, `entity_audit_log`, `facts.superseded_by_override` |
| 377 | rel_edges evidence | `rel_edges.evidence_count` / `last_evidence_at`, `relationship_infer_queue` |
| 378 | compute_nodes (external pool) | `compute_nodes`, `compute_job_assignments` |
| 379 | system_health | `ops_incidents`, `external_api_probes`, `health_snapshots` |
| 380 | hot_indexes | expression indexes for nullable-ORDER-BY nightly queries |

## Feature-specific notes
Only the non-obvious details beyond the global conventions above.

- **Deal dedupe** — key is `sha256(normalized_company | event_type |
  round | month_bucket)`; `event_type` required (`dealDedupeKey()`
  returns null when missing). The AI extractor rejects unrecognized
  `event_type` rather than coercing to `funding_round`. SEC Form D rows
  (round_name=null) corroborate press-wire rows via a round-flexible
  persist lookup.
- **Fund returns** — invested capital is the SUM OF FUND CHECKS
  (`deal_participants.position_usd`), not round sizes; positions with no
  check size contribute 0 and emit a `no_check_size` warning. Confidence:
  ≥70% positions resolved → high, 40–70% → medium, <40% → low (only
  ipo/acquisition/merger/bankruptcy count as resolved). Calibration loop
  is a no-op until LP fund-level actuals exist in `lp_fund_commitments`.
- **Intro routing** — pathfinder is exhaustive simple-path DFS, hop cap
  3, neighbor cap 200, ranked by Σ 1/(quality+0.1). When every edge
  lacks `quality_score` it flips to `ranking_mode="hop_count_only"` and
  returns `predicted_conversion_pct=null` (never a fake number). Logistic
  model retrains nightly only once ≥25 labeled outcomes with both classes
  exist; Brier score persisted per run. Opener uses `gpt-4o-mini` when
  `OPENAI_API_KEY` is set, else a deterministic template; both clamp to
  60 words.
- **Investor reputation** — min-sample gate: aggregates persist
  regardless of sample size but stay private (`is_public=0`) and the
  public projection nulls EVERY aggregate until `sample_size ≥ 5`.
  Founder feedback is anonymized before persist (PII stripped; identity
  survives only as a salted one-way hash); route 503s when
  `FOUNDER_FEEDBACK_SALT` is unset.
- **ML quality ops** — bundled gold sets are starter samples
  (20–26 rows), grown in-place via UNIQUE(dataset_id, example_key).
  `guardedInsertFact` runs `verifySourceSpan` before `insertFact`;
  failing rows append to `hallucination_flags` and never reach the
  ledger. Regression gate fails on >5% (or >5pp local) drift; deploy
  runs the gate between typecheck and migration-apply.
- **External worker pool** — default routing matrix lives in code
  (`services/compute/routing.ts`), overrides via
  `compute_nodes.capabilities_json`; no routing-rules table. Admin mint
  is `/api/ops/compute-nodes/register-token`; runner endpoints are flat
  (`/api/compute/{register-exchange,heartbeat,pull,complete}`) with
  node_id/assignment_id in a signed HMAC envelope, mounted before
  `accessGuard`. Per-node HMAC secret crosses the wire ONCE (registration
  response), then lives only in KV. **KNOWN GAP:** `dispatchExternalJob`
  is built + unit-tested but not yet wired into any in-Workers consumer.
- **System health** — 5-min rollup target dropped to **hourly
  piggyback** (`0 * * * *`); `GET /api/ops/system-health` does an
  on-demand snapshot when the latest bucket is >5 min stale. Email
  (`ALLOWED_EMAIL` via MailChannels) is the primary alert channel;
  optional `SLACK_WEBHOOK_URL` is secondary; delivery failures are
  recorded on `ops_incidents.delivery_status`. Incidents auto-close after
  2 clean ticks (counter in `SESSIONS` KV).
- **Comprehensive bug sweep (PARTIAL).** Landed: garbage-sweep,
  csv-name-remap, profile `/health` probe endpoint, stuck-import sweep,
  investors stray-metadata fix, and the Quality Console at `/ops/quality/`.
  **Deferred (next pass):** F (scraper-side `decodeEntities` at the write
  path), G (persona-kinds sanity test), H (Projects auto-match), I
  (Profile inline edit/delete UI), J (Relationships inference run), K
  (route-audit walk), L (per-page console-error pass), M (Access JWT
  parsing audit).

## User preferences
- (none recorded yet)
