---
name: Production deploy path
description: How the Cloudflare worker actually reaches production, and why the main agent can't do it directly.
---

The worker deploys to api.aidatasignal.com via the `Deploy Cloudflare Worker (lead)`
GitHub Action (`.github/workflows/deploy-worker.yml`). It runs
`wrangler d1 migrations apply DB --remote` then `wrangler deploy`, using the
`CLOUDFLARE_API_TOKEN` stored as a GitHub repo secret.

Triggers: push to `main` touching `apps/worker/**`, `package.json`, or the
workflow file (path-filtered) — OR `workflow_dispatch` (manual run, ignores the
path filter).

**Main agent cannot ship to prod directly.** Confirmed:
- `git push` from the workspace fails: "Invalid username or token. Password
  authentication is not supported." No working GitHub write auth in the main
  environment.
- `gh` CLI is installed but unauthenticated; no `GH_TOKEN`/`GITHUB_TOKEN` in env.
- No `CLOUDFLARE_API_TOKEN` in the workspace env, so no direct `wrangler deploy`
  either.

**Why:** local `main` (Replit auto-commit) and `origin/main` (platform task-agent
merges) are separate; main-agent commits only reach origin/main if pushed, which
fails here. So a redeploy must come from GitHub itself: either a merge/commit that
touches `apps/worker/**` lands on origin/main (triggering the Action), or someone
runs the workflow manually via `workflow_dispatch`.

**Gotcha that broke a "just push to deploy" plan:** the worker code can already be
on origin/main while production is still stale — meaning a prior deploy failed or
never ran, NOT that code is missing. Verify with
`git diff --stat origin/main..HEAD -- apps/worker` (empty = worker code already
shipped to GitHub). When it's empty, pushing local commits does nothing for the
worker; the fix is to (re)trigger the Action and inspect its run logs (likely an
expired CLOUDFLARE_API_TOKEN secret or a failing eval/drift gate).
