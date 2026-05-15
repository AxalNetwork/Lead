# aidatasignal worker (`lead`)

Cloudflare Worker that powers `api.aidatasignal.com`. Deployed by
`.github/workflows/deploy-worker.yml` on every push to `main` that
touches `apps/worker/**`.

## Required Cloudflare resources

Account: `30c9362191318777b71647145decda48`.
Anything declared in `wrangler.toml` MUST exist in the account before
`wrangler deploy` can succeed. The deploy workflow (Task #39) now
auto-creates R2 buckets, Vectorize indexes, Queues, and KV namespaces,
and probes Analytics Engine datasets via the AE SQL endpoint.

The same workflow also runs a drift detector (Task #43) right before
`wrangler deploy`. It lists every R2 bucket, Queue, and Vectorize
index that actually lives in the account and compares against
`wrangler.toml`:

- **Orphan** (resource exists in the CF account but no binding in
  `wrangler.toml`) prints a warning to the workflow log but does NOT
  fail the deploy — it's frequently intentional (e.g. keeping a
  bucket around while removing its binding). Add the resource name
  to `apps/worker/.cf-orphan-allowlist` (one per line, `#` comments
  ok) to suppress a known orphan.
- **Drift** (Vectorize index exists on both sides but the live
  dimensions/metric don't match the `# dim=N metric=M` annotation in
  `wrangler.toml`) is FATAL — querying a 768-d index as if it were
  1024-d silently corrupts results, so we'd rather fail the deploy
  than ship.

A note on each:

- **Vectorize**: each `[[vectorize]]` block must annotate dimensions
  and metric on the `index_name` line as `# dim=N metric=M`. Wrangler
  ignores the comment; the deploy workflow parses it so the index is
  created with the correct shape. Missing annotation falls back to
  768/cosine with a loud warning.
- **KV namespaces**: the workflow creates the namespace by title
  (matching the `binding` name). Cloudflare KV binds by `id`, not by
  name, so the first deploy that introduces a new KV namespace prints
  an `ACTION REQUIRED` line with the new id; paste it into the
  `[[kv_namespaces]]` block. Subsequent deploys are no-ops because the
  title already exists.
- **Analytics Engine**: Cloudflare exposes no create-dataset endpoint.
  Datasets self-provision on the Worker's first `writeDataPoint`, so
  the workflow probes the AE SQL endpoint per dataset and accepts both
  `"exists and queryable"` and `"table not found"` as success, failing
  only on auth/account errors so a bad token or typo surfaces in CI
  rather than in production.

| Kind             | Name                       | How to create                                                                 |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------- |
| D1               | `aidatasignal-leads` (id `ecd7272e-533d-4e01-81ba-e1b98bce6e1c`) | `wrangler d1 create aidatasignal-leads`                                       |
| KV               | `SESSIONS` / `SCRAPE_CACHE` (id `302eb1a32ae64ce588dee452e14b3217`) | auto-created by the deploy workflow (`Ensure KV namespaces exist` step); paste the returned id into `[[kv_namespaces]]` on first introduction |
| R2               | `aidatasignal-raw-html`    | auto-created by the deploy workflow (`Ensure R2 buckets exist` step)          |
| R2               | `aidatasignal-uploads`     | auto-created by the deploy workflow                                           |
| R2               | `aidatasignal-ai-cache`    | auto-created by the deploy workflow                                           |
| Queue            | `aidatasignal-lead-jobs`   | auto-created by the deploy workflow (`Ensure Queues exist` step)              |
| Browser Render   | `BROWSER`                  | enabled per-account in CF dashboard                                           |
| Workers AI       | `AI`                       | enabled per-account in CF dashboard                                           |
| Vectorize × 6    | `axal-{leads,firms,companies,accounts,personas,projects}-768` (768d, cosine) | auto-created by the deploy workflow (`Ensure Vectorize indexes exist` step)   |
| Durable Object   | `EntityLock` (binding `ENTITY_LOCK`) | created on first deploy via the `[[migrations]]` block                        |
| Analytics Engine | dataset `axal_events`      | auto-provisioned by Cloudflare on the first `writeDataPoint` call; deploy workflow probes via AE SQL |
| Images           | `IMAGES`                   | enable Cloudflare Images for the account                                      |
| Rate Limiter × 2 | `RL_HOST` (ns 1001), `RL_AI` (ns 1002) | declared as `[[unsafe.bindings]]` — created on first deploy                   |
| Workflows × 7    | `enrich-lead`, `enrich-firm`, `ingest-page`, `enrich-account`, `crawl-signals`, `rescore-persona`, `match-project` | created on first deploy via `[[workflows]]` blocks                            |
| Custom domain    | `api.aidatasignal.com`     | route declared in `apps/worker/wrangler.toml`; DNS + zone must be in this account |

## Required secrets

Set via `wrangler secret put NAME` (or in the CF dashboard):

- `CLOUDFLARE_API_TOKEN` (GitHub Actions secret) — see required scopes below.
- Per-provider API keys: `HUNTER_API_KEY`, `APOLLO_API_KEY`,
  `ROCKETREACH_API_KEY`, `PEOPLEDATALABS_API_KEY`, `PROXYCURL_API_KEY`,
  `CRUNCHBASE_API_KEY`, `WHOISXML_API_KEY`, `BRAVE_API_KEY`,
  `SCRAPING_API_KEY`, `PROXY_URL` (optional).

### Required scopes for `CLOUDFLARE_API_TOKEN`

The deploy workflow (`.github/workflows/deploy-worker.yml`) calls the
Cloudflare REST API directly to pre-create resources before
`wrangler deploy` runs, then runs drift detection, then `d1 migrations
apply --remote`, then `wrangler deploy` itself. Each step requires a
specific scope. Mint the token in the Cloudflare dashboard (account
`30c9362191318777b71647145decda48`) and grant **all** of the following
account-scoped permissions, scoped to "Include → All accounts" (or
this account specifically):

All of the following scopes are **mandatory** — the deploy workflow
fails hard on any missing scope (auth errors return `code:10000`,
which the affected step surfaces with a pointer back to this section):

| Scope                          | Used by                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| **Workers Scripts: Edit**      | `wrangler deploy` (uploads the worker bundle, custom domain route)   |
| **Workers KV Storage: Edit**   | `Ensure KV namespaces exist` step + KV writes during deploy          |
| **Workers R2 Storage: Edit**   | `Ensure R2 buckets exist` step + R2 binding validation               |
| **D1: Edit**                   | `Apply D1 migrations (remote)` step + D1 binding validation          |
| **Vectorize: Edit**            | `Ensure Vectorize indexes exist` step + Vectorize drift detection    |
| **Queues: Edit**               | `Ensure Queues exist` step + queue producer/consumer binding         |
| **Workers AI: Read**           | runtime AI binding validation                                        |
| **Account Analytics: Read**    | `Ensure Analytics Engine datasets are reachable` step (AE SQL probe) |

Symptoms of a missing scope: the affected workflow step exits 1 with
`AUTH FAILURE: token is missing <Scope>` and the raw Cloudflare API
response (`{"success":false,"errors":[{"code":10000,"message":"Authentication error"}],…}`).
The fix is always to mint a new token with the full set above and
rotate the secret — see the rotation procedure below.

To rotate without downtime: mint the new token first, paste it into
the `CLOUDFLARE_API_TOKEN` repo secret (Settings → Secrets and
variables → Actions), trigger a `workflow_dispatch` run of
`deploy-worker.yml` to confirm it goes green, then revoke the old
token in the CF dashboard.

## Remote D1 migrations

Migrations are **applied automatically on every push to `main`** by the
`Deploy Cloudflare Worker (lead)` GitHub Action — the workflow runs
`wrangler d1 migrations apply DB --remote` immediately before
`wrangler deploy`, so the schema is always at-or-ahead of the code
that's about to ship. The step is idempotent (D1 tracks applied
migrations in the `d1_migrations` table) and a failed migration halts
the deploy.

To apply manually from `apps/worker` (e.g. for an out-of-band
hotfix):

```sh
CLOUDFLARE_API_TOKEN=… npx wrangler d1 migrations apply DB --remote
```

If `d1_migrations` ever falls out of sync with the actual schema (e.g.
older migrations were applied manually before the migration tracker
existed), reconcile by inserting the already-applied migration names
into `d1_migrations` (`INSERT OR IGNORE INTO d1_migrations (name)
VALUES (...)`) before re-running `apply --remote`. As of 2026-05-15
all migrations through `162_accounts_domain_unique.sql` are applied to
the remote D1 (`ecd7272e-533d-4e01-81ba-e1b98bce6e1c`).

## Local dev

```sh
cd apps/worker
npm install
npm run typecheck
npx wrangler deploy --dry-run   # validates bindings without uploading
npx wrangler dev                 # local dev server
```

Wrangler 4.x (used in local dev) requires Node ≥ 22. The CI workflow
uses Node 20 + wrangler 3.99.0 and is fine on either.

## Adding a new runtime dependency

Until this repo moves to npm/pnpm workspaces, every runtime dep added
to `apps/worker/package.json` MUST also be mirrored verbatim (same
version specifier, including tarball URLs) in the root `package.json`
so `npm ci` at the repo root resolves the same tree the GitHub Actions
deploy job sees. Refresh the root `package-lock.json` (`npm install`
at the repo root) and commit both files.

## Adding a new binding

`apps/worker/wrangler.toml` is the **single source of truth** for
every Worker binding, var, route, cron, and Workflow class. There is
no longer a root-level `wrangler.toml` — Task #73 deleted it after a
manual `wrangler deploy` from the repo root silently shipped a Worker
missing `UPLOADS`/`AI`/`AI_CACHE`/Vectorize/Workflow bindings (the
root file had drifted to a stale subset). Every deploy path now goes
through `apps/worker/`:

- GitHub Actions (`Deploy Cloudflare Worker (lead)`) sets
  `working-directory: apps/worker` and the `cloudflare/wrangler-action`
  step pins `workingDirectory: apps/worker`.
- The repo-root `npm run deploy` script `cd`s into `apps/worker`
  before invoking `wrangler deploy`.
- Manual deploys must also `cd apps/worker` first; running
  `wrangler deploy` from the repo root will now fail loudly with
  "no config file found", which is the intended behaviour.

To add a binding:

1. Add the binding stanza to `apps/worker/wrangler.toml` only.
2. If it's a new R2 bucket, Vectorize index, Queue, KV namespace, or
   Analytics Engine dataset, the deploy workflow handles provisioning
   automatically. For KV, paste the new id from the workflow output
   into the `[[kv_namespaces]]` block. For Vectorize, include the
   `# dim=N metric=M` annotation on the `index_name` line.
3. For D1, create the resource manually in the CF account and update
   the table above.
4. Add the typed shape to `src/types.ts`.
5. `npm run typecheck` and push.
