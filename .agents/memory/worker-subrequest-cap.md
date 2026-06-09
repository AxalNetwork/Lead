---
name: Worker subrequest cap & per-batch budget
description: Real Cloudflare subrequest ceiling for the Lead worker and how the crawl subrequest budget is scoped.
---

The Lead worker's per-invocation subrequest ceiling is **~1000 (paid Workers
plan)**, NOT the Free-plan 50.

**Why:** the worker uses Cloudflare Queues (`[[queues.producers]]` /
`[[queues.consumers]]` in `apps/worker/wrangler.toml`), and Queues are only
available on the paid Workers plan. So despite `replit.md` saying "CF Free plan
caps crons at 5/5", the account is on a paid Workers plan and the subrequest
cap is 1000. `imports/import.ts` using a 700 budget corroborates this (a 700
budget would be inert on a 50 cap). The crawl path's `CRAWL_SUBREQUEST_BUDGET`
is therefore 700, leaving ~300 headroom for un-pre-flighted sinks.

**How to apply:** any future "Too many subrequests" tuning starts from a 1000
ceiling. Don't re-derive it as 50. All subrequests count toward it — not just
`fetch`, but every D1/KV/R2 binding call too.

The crawl subrequest budget (`scraper/subrequestBudget.ts`) is scoped
**per queue batch (one Worker invocation), shared across all jobs in the
batch** — created once in `index.ts` and threaded down. It is NOT per-job.

**Why:** subrequests accumulate per invocation, and a queue batch is processed
in a single invocation. A consequence: a job that re-enqueues itself on budget
exhaustion (e.g. `firm_team_crawl`) is NOT guaranteed a fresh budget on retry —
its replacement can land in another already-saturated batch. So such
re-enqueues need a bounded attempt counter (don't assume "fresh invocation =
fresh budget"), or they can churn the queue forever.
