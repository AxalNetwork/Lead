---
name: Production deploy path
description: How the Cloudflare worker reaches production, what the workspace CAN/can't do directly, and the current gate state.
---

The worker deploys to api.aidatasignal.com via the `Deploy Cloudflare Worker (lead)`
GitHub Action (`.github/workflows/deploy-worker.yml`). It runs
`wrangler d1 migrations apply DB --remote` then `wrangler deploy`, with a
`Typecheck` (tsc) gate and an ML-eval regression gate between.

Triggers: push to `main` touching `apps/worker/**`, `package.json`, or the
workflow file — OR `workflow_dispatch` (manual run, ignores the path filter).

**What the workspace CAN do directly (confirmed 2026-06-02):** the workspace env
has `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets, so
`npx wrangler@3.99.0 d1 ... --remote`, `wrangler d1 migrations apply DB --remote`,
and `wrangler secret put <NAME>` (pipe the value via `printf '%s' "$VAL" |`)
all work against prod. Worker secrets set this way take effect on the LIVE
worker immediately — no redeploy needed (e.g. PROXY_URL).

**What it CANNOT do:**
- `git push` fails ("Invalid username or token") — no GitHub write auth; `gh` is
  unauthenticated. Pushing/rebasing must be delegated to a background project task.
- A direct `wrangler deploy` is *technically* possible (token is present) but is
  the wrong tool: it ships LOCAL `main`, which is routinely several un-pushed
  checkpoint commits ahead of `origin/main` (the Replit auto-commit divergence),
  so it would ship unrelated un-reviewed work AND bypass the typecheck + ML-eval
  gates. Don't do it without explicit user approval.

**Current gate state (updated 2026-06-09): CI deploy is GREEN and auto-deploying.**
`deploy-worker.yml` shipped prod multiple times on 2026-06-09 (e.g. version
`334d2ef7…` at 18:25 UTC off the Task #57 push) — the typecheck gate that was
RED on 2026-06-02 is no longer the blocker. `check.yml` (lint + test build)
remains red, but that is a *separate* workflow and does NOT gate deploys.

**Verifying a route is live in prod WITHOUT curl (Access blocks probing).**
Every `api.aidatasignal.com/*` path 302s to the Access login identically —
even known-good routes like `/api/health` — so curl CANNOT distinguish a 404
from a 200. The CF `workers/scripts/lead/content` endpoint also rejects the
api-token auth scheme (`10405`), so you can't grep the deployed bundle either.
Instead, prove a route is shipped indirectly: (1) confirm the route's introducing
commit is an ancestor of `origin/main` (`git merge-base --is-ancestor <sha>
origin/main`); (2) list CF deployments
(`GET …/workers/scripts/lead/deployments`) and confirm a deploy happened AFTER
that commit landed — a `wrangler deploy` bundles the WHOLE worker, so ANY
successful worker deploy ships EVERY route on the deployed ref, not just the
triggering change; (3) confirm backing tables exist via
`wrangler d1 execute DB --remote --command "SELECT name FROM sqlite_master …"`.
A genuine end-to-end check still needs a real operator browser session.

**Manual wrangler deploy is a real escape hatch (confirmed 2026-06-02).** With
explicit user approval, `cd apps/worker && npx wrangler@3.99.0 deploy` from the
workspace succeeds even while the CI typecheck gate is RED — wrangler bundles via
esbuild, which strips types and ignores the `tsc` errors. It ships whatever is on
LOCAL `main`, so only do it when local == `origin/main` (verify `git rev-list
--left-right --count origin/main...HEAD` is `0 0`) to avoid shipping un-pushed
checkpoint commits. It bypasses the typecheck + ML-eval gates, so it ships every
worker task merged since the last green CI run, not just the latest change — call
that out to the user before running.

**D1 prod repair recipe (when the migration chain is stalled):** a leftover/orphan
object (e.g. a hand-created table) can block `migrations apply`. Identify the
blocker from the apply error, drop/rename it via
`wrangler d1 execute DB --remote --command "..."`, then re-run
`wrangler d1 migrations apply DB --remote`. Migrations can be applied to prod
this way independently of a worker code deploy.
