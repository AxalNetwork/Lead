# AI Data Signal — Admin Platform

Single-user lead-intelligence admin platform fronted by Cloudflare Access.

## Layout

```
apps/
  site/      # Jekyll admin dashboard  → app.aidatasignal.com
  worker/    # Cloudflare Worker API   → api.aidatasignal.com
docs/
  auth-and-access.md
.local/
  cf-resources.json   # provisioned Cloudflare resource IDs
```

## Quick start (dev)

The Replit workflow `Start application` runs the Jekyll site on port 5000.

```bash
cd apps/site && bundle exec jekyll serve --host 0.0.0.0 --port 5000
```

Worker dev:

```bash
cd apps/worker && pnpm install && pnpm dev
```

## Deployment

- **Site**: Replit static deployment builds `apps/site` into `apps/site/_site` and serves it. Production custom domain `app.aidatasignal.com` (DNS pending — see notes).
- **Worker**: `cd apps/worker && wrangler deploy` deploys to the `lead` Worker, attached to `api.aidatasignal.com`.

## Auth

Cloudflare Access on both subdomains, OTP login, allowlist `guillaumelauzier@gmail.com`. See `docs/auth-and-access.md`.
