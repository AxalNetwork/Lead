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

**Current gate state (2026-06-02): CI deploy is RED.** `cd apps/worker &&
npx tsc --noEmit` fails on 5 pre-existing unrelated null-type errors
(investorResolver / fundResolver / intl·persist / lpDisclosures·persist /
secEdgar·xref) — same root as the "fix worker test suite" task. So even a
successful push would NOT deploy until that compile task lands. Verify with
`git diff --stat origin/main..HEAD -- apps/worker` (empty = worker code already
on GitHub; non-empty = local has un-pushed worker commits).

**D1 prod repair recipe (when the migration chain is stalled):** a leftover/orphan
object (e.g. a hand-created table) can block `migrations apply`. Identify the
blocker from the apply error, drop/rename it via
`wrangler d1 execute DB --remote --command "..."`, then re-run
`wrangler d1 migrations apply DB --remote`. Migrations can be applied to prod
this way independently of a worker code deploy.
