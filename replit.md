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

## User preferences
- (none recorded yet)
