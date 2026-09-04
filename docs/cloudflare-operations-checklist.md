# Cloudflare — everything required to run operations

Single checklist of what must exist in Cloudflare for the Worker
(`apps/worker`, deployed as `lead` on `api.aidatasignal.com`) and its
operations features to work. Account `30c9362191318777b71647145decda48`,
zone `aidatasignal.com`, Zero Trust org `axalnetwork.cloudflareaccess.com`.

Three ways to provision, in order of preference:

1. **Deploy workflow** (`.github/workflows/deploy-worker.yml`) — creates
   R2, Vectorize, Queues, KV, probes Analytics Engine, applies D1
   migrations, then deploys. Needs the `CLOUDFLARE_API_TOKEN` repo secret
   with the scopes listed in `apps/worker/README.md`.
2. **Local provisioner** — `cd apps/worker && CLOUDFLARE_API_TOKEN=… npm run cf:provision`
   (`scripts/provision-cf.mjs`) does the same resource pre-create from a
   workstation and reports which Worker secrets are still missing. Pass
   `--dry-run` to only diff.
3. **Dashboard** — for the items marked *dashboard only* below.

## 1. Plan and account-level features

| Item | Why | How |
| --- | --- | --- |
| **Workers Paid plan** | Queues, Durable Objects (SQLite-backed `EntityLock`, `HostThrottle`), Workflows (29 declared), and the ~1000 subrequests/invocation ceiling the queue consumer is tuned for all require the paid plan. | Dashboard → Workers & Pages → Plans. *dashboard only* |
| **Workers AI** enabled | `AI` binding: extraction, embeddings (`@cf/baai/bge-base-en-v1.5`), OCR, arbitration. | Enabled per account on first use; confirm in Dashboard → AI → Workers AI. |
| **Browser Rendering** enabled | `BROWSER` binding: tier-1 fetcher fallback for JS-rendered pages. | Dashboard → Workers & Pages → Browser Rendering. *dashboard only* |
| **Cloudflare Images** enabled | `IMAGES` binding: avatar/logo upload. Set `CF_IMAGES_ACCOUNT_HASH` secret to serve variants. | Dashboard → Images. *dashboard only* |
| **Analytics Engine** | `ANALYTICS` binding, dataset `axal_events` (dashboard KPIs, cost rollups). Self-provisions on first `writeDataPoint`. | Nothing to create; the workflow only probes it. |

## 2. Storage and compute resources (`apps/worker/wrangler.toml` is the source of truth)

| Kind | Name / id | Created by |
| --- | --- | --- |
| D1 | `aidatasignal-leads` (`ecd7272e-533d-4e01-81ba-e1b98bce6e1c`) | Manual once (`wrangler d1 create aidatasignal-leads`) then paste id. Migrations `001…380` applied by the deploy workflow (`wrangler d1 migrations apply DB --remote`). |
| KV | `SESSIONS` (`302eb1a32ae64ce588dee452e14b3217`), `SCRAPE_CACHE` (`fe0a5d907b9841f98914f3076500e75d`) | Workflow / provisioner (by title); ids must be pasted into `[[kv_namespaces]]` on first creation. |
| R2 | `aidatasignal-raw-html`, `aidatasignal-uploads`, `aidatasignal-ai-cache`, `aidatasignal-imports`, `aidatasignal-transcripts` | Workflow / provisioner. Add a 30-day lifecycle rule on `aidatasignal-ai-cache` (dashboard) so the AI response cache does not grow forever. |
| Vectorize (768-d, cosine) | `axal-leads-768`, `axal-firms-768`, `axal-companies-768`, `axal-accounts-768`, `axal-personas-768`, `axal-projects-768` | Workflow / provisioner from the `# dim=768 metric=cosine` annotations. Drift in dimensions is fatal in CI by design. |
| Queue | `aidatasignal-lead-jobs` (producer `LEAD_QUEUE`, consumer batch 3 / timeout 5s) | Workflow / provisioner. |
| Durable Objects | `EntityLock`, `HostThrottle` (SQLite classes, `[[migrations]]` v1/v2) | `wrangler deploy`. |
| Workflows | 29 `[[workflows]]` entries (`enrich-lead` … `persona-match-entity`) | `wrangler deploy`. |
| Rate limiters | `RL_HOST` (60/min, ns 1001), `RL_AI` (600/min, ns 1002) | `wrangler deploy` (`[[unsafe.bindings]]`). |
| Cron triggers | `0 * * * *`, `0 */6 * * *`, `15 3 * * *`, `0 4 * * *`, `30 4 * * *` — all five slots used | `wrangler deploy`. **Do not add crons**; piggyback the `15 3` slot. |
| Custom domain | `api.aidatasignal.com` (`[[routes]] custom_domain = true`) | `wrangler deploy`; the zone must be in the same account. |

## 3. Cloudflare Access (Zero Trust)

| Item | Value / action |
| --- | --- |
| Access application (API) | App id `7bfdd50e-d205-4d09-84bf-77da0ee7b79e`, AUD `f9cbce05…849dd` (= `ACCESS_AUD`). Domain `api.aidatasignal.com`. |
| Access application (dashboard) | AUD `36772346…cb3e79` (= `ACCESS_APP_AUD`). Domain `aidatasignal.com` / `app.aidatasignal.com`. |
| Identity provider | One-time PIN (`2d4da1a1-ae2d-434f-b38a-d6b1bf3d7e30`). |
| Allow policy | Emails: `guillaumelauzier@gmail.com` (+ anything in `ADMIN_EMAILS`). The Worker re-checks the JWT email against `ALLOWED_EMAIL`/`ADMIN_EMAILS`, so both lists must agree. |
| Session duration | 24h. |
| **CORS preflights** | Access answers `OPTIONS` with a login redirect, so the dashboard tunnels every write as a CORS-simple request (`adsUtil.request` ⇄ `middleware/simple_request.ts`). Optional hardening: on the **API** Access app set *Settings → CORS → "Bypass OPTIONS requests to origin"* and allow origin `https://aidatasignal.com` with credentials; the Worker's own `cors()` middleware then answers preflights and the tunnel becomes a no-op. *dashboard only* |

## 4. Worker secrets (`cd apps/worker && printf '%s' "$VAL" | npx wrangler secret put NAME`)

Every secret is optional: the code degrades honestly (feature reports
`unconfigured`) when it is absent. Set the ones for the operations you
want to run.

| Secret | Unlocks |
| --- | --- |
| `FOUNDER_FEEDBACK_SALT` | Anonymous founder feedback (`POST /api/founder-feedback` returns 503 without it). Any long random string. |
| `SLACK_WEBHOOK_URL` | Secondary alert channel for system-health incidents (email via MailChannels to `ALLOWED_EMAIL` is primary). |
| `ADMIN_EMAILS` | Extra ops admins for `/api/ops/*` (comma-separated). Optional; `ALLOWED_EMAIL` is admin by default. Can be a plain var. |
| `PERSONA_RESCORE_SECRET` | Authenticates the persona rescore-all trigger. |
| `OPENAI_API_KEY` / `AGENT_FALLBACK_KEY` | GPT fallback for the research agent and intro-opener (`AGENT_FALLBACK_PROVIDER = "openai"`); Workers AI is used otherwise. |
| `CF_IMAGES_ACCOUNT_HASH` | Serving Cloudflare Images variants for avatars/logos. |
| `PROXY_URL` / `PROXY_AUTH`, `SMARTPROXY_URL` / `_AUTH`, `BRIGHTDATA_URL` / `_AUTH`, `OXYLABS_URL` / `_AUTH`, `SCRAPERAPI_KEY`, `SCRAPESTACK_KEY` | Tier-2 proxy failover for the crawler. Without at least one, url-kind jobs are skipped with `proxy_not_configured` (see `scraper/preflight.ts`). |
| `FEC_API_KEY`, `OPENSECRETS_API_KEY`, `PROPUBLICA_API_KEY`, `CONGRESS_API_KEY` | Political donations / government appointments enrichment. |
| `COURTLISTENER_TOKEN`, `PACER_USER` / `PACER_PASS` | Litigation verifier. |
| `COMPANIES_HOUSE_API_KEY` | UK Companies House adapter. |
| `NEWS_API_KEY`, `NEWSAPI_KEY` | News refresh augmentation (RSS/GDELT work without them). |
| `BRAVE_API_KEY`, `SCRAPING_API_KEY` | Brave search fallback / scraping API (legacy, optional). |

Vars already in `wrangler.toml` (`[vars]`): `ENVIRONMENT = "production"`
(must stay set — it disables the `X-Admin` header escape hatch and turns
on sanitized error envelopes), `ALLOWED_EMAIL`, `ACCESS_*`, AI model ids
and budget caps, aggregator page budgets.

## 5. GitHub Actions

| Secret | Scopes |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Workers Scripts: Edit · Workers KV Storage: Edit · Workers R2 Storage: Edit · D1: Edit · Vectorize: Edit · Queues: Edit · Workers AI: Read · Account Analytics: Read (see `apps/worker/README.md` for symptoms of a missing scope). |

## 6. Verifying an environment

```sh
cd apps/worker
CLOUDFLARE_API_TOKEN=… npm run cf:provision -- --dry-run   # diff declared vs live
npx wrangler deploy --dry-run                              # validate bindings
npx wrangler d1 migrations list DB --remote                # pending migrations
```

Then, in an operator browser session (Access blocks curl):
`GET https://api.aidatasignal.com/api/health/deep` probes every binding, and
`/ops/system-health/` shows the latest health snapshot and open incidents.

## Known state (2026-09-04)

The Cloudflare account connected to the Claude Code session that produced
this checklist is **not** account `30c9362191318777b71647145decda48`: it
holds none of the resources above (no `lead` Worker, no `aidatasignal-*`
buckets, and the D1 id returns 404). Provisioning was therefore not run
from the session; use the deploy workflow or the local provisioner with a
token for the correct account.
