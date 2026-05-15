# aidatasignal worker (`lead`)

Cloudflare Worker that powers `api.aidatasignal.com`. Deployed by
`.github/workflows/deploy-worker.yml` on every push to `main` that
touches `apps/worker/**`.

## Required Cloudflare resources

Account: `30c9362191318777b71647145decda48`.
Anything declared in `wrangler.toml` MUST exist in the account before
`wrangler deploy` can succeed. The deploy workflow auto-creates R2
buckets; everything else has to be created out-of-band.

| Kind             | Name                       | How to create                                                                 |
| ---------------- | -------------------------- | ----------------------------------------------------------------------------- |
| D1               | `aidatasignal-leads` (id `ecd7272e-533d-4e01-81ba-e1b98bce6e1c`) | `wrangler d1 create aidatasignal-leads`                                       |
| KV               | `SESSIONS` / `SCRAPE_CACHE` (id `302eb1a32ae64ce588dee452e14b3217`) | `wrangler kv namespace create SESSIONS`                                       |
| R2               | `aidatasignal-raw-html`    | auto-created by the deploy workflow (`Ensure R2 buckets exist` step)          |
| R2               | `aidatasignal-uploads`     | auto-created by the deploy workflow                                           |
| R2               | `aidatasignal-ai-cache`    | auto-created by the deploy workflow                                           |
| Queue            | `aidatasignal-lead-jobs`   | `wrangler queues create aidatasignal-lead-jobs`                               |
| Browser Render   | `BROWSER`                  | enabled per-account in CF dashboard                                           |
| Workers AI       | `AI`                       | enabled per-account in CF dashboard                                           |
| Vectorize × 3    | `axal-{leads,firms,companies}-768` (768d, cosine) | `wrangler vectorize create axal-leads-768 --dimensions=768 --metric=cosine`   |
| Durable Object   | `EntityLock` (binding `ENTITY_LOCK`) | created on first deploy via the `[[migrations]]` block                        |
| Analytics Engine | dataset `axal_events`      | enable Analytics Engine for the account in the CF dashboard before deploying  |
| Images           | `IMAGES`                   | enable Cloudflare Images for the account                                      |
| Rate Limiter × 2 | `RL_HOST` (ns 1001), `RL_AI` (ns 1002) | declared as `[[unsafe.bindings]]` — created on first deploy                   |
| Workflows × 3    | `enrich-lead`, `enrich-firm`, `ingest-page` | created on first deploy via `[[workflows]]` blocks                            |
| Custom domain    | `api.aidatasignal.com`     | route declared in `wrangler.toml`; DNS + zone must be in this account         |

## Required secrets

Set via `wrangler secret put NAME` (or in the CF dashboard):

- `CLOUDFLARE_API_TOKEN` (GitHub Actions secret) — needs Workers Scripts
  Edit + R2 Edit + D1 Edit on the account.
- Per-provider API keys: `HUNTER_API_KEY`, `APOLLO_API_KEY`,
  `ROCKETREACH_API_KEY`, `PEOPLEDATALABS_API_KEY`, `PROXYCURL_API_KEY`,
  `CRUNCHBASE_API_KEY`, `WHOISXML_API_KEY`, `BRAVE_API_KEY`,
  `SCRAPING_API_KEY`, `PROXY_URL` (optional).

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

## Adding a new binding

1. Add the binding stanza to `wrangler.toml`.
2. If it's a new R2 bucket, the deploy workflow auto-creates it.
3. For anything else (D1, KV, Vectorize, Queue, AE dataset), create the
   resource manually in the CF account and update the table above.
4. Add the typed shape to `src/types.ts`.
5. `npm run typecheck` and push.
