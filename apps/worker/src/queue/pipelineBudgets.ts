// Task #7: per-pipeline budget_ms overrides.
//
// The default budget for a queued job is 90s (`90_000` ms). For a few
// pipelines this is genuinely too tight — e.g. firm_team_crawl walks
// up to 50 partner pages per firm and routinely runs 100-180s on cold
// hosts. Without an override the in-run deadline / admin.sweep would
// kill them every night even when they're making honest progress.
//
// This module is intentionally a pure config-style map: no DB, no env
// — easy to unit test, easy to reason about, easy to grep for which
// pipelines have been bumped and why.
//
// Lookup contract: `budgetForPipeline(kind)` returns the override in
// ms when one is configured, else `null`. Callers combine it with the
// per-job `jobs.budget_ms` and the global default via
// `effectiveBudgetMs(jobBudgetMs, kind)` so the result is always
// `max(jobBudgetMs ?? default, override ?? 0)`. The job-row column
// remains authoritative; the override only LIFTS it, never lowers it,
// so an operator-set tight budget still wins.

export const DEFAULT_BUDGET_MS = 90_000;

/**
 * Per-pipeline budget_ms overrides. Keys MUST match `JobMessage.kind`
 * values in `src/types.ts` (or the aliased kinds `enrich_lead` /
 * `crawl_url` which normalize to `profile_list` / `url` before the
 * deadline check fires).
 *
 * Seed values are based on the swept-job sample from the week of
 * 5/17 (`workflow_step_failed` cluster, 121 rows). Pipelines whose
 * median wall-clock time exceeded 60s of the 90s budget appear here.
 * Re-tune by running the DB-error panel's sibling sweep-attribution
 * query (`SELECT kind, COUNT(*) FROM jobs WHERE status='timed_out'
 * GROUP BY kind`) and bumping the worst offenders.
 */
export const PIPELINE_BUDGETS_MS: Readonly<Record<string, number>> = Object.freeze({
  // Walks the firm's partner roster page-by-page. Cold hosts + ~50
  // partner pages frequently push past 90s.
  firm_team_crawl: 180_000,
  // Discover walks the seed root + 1-2 hop expansion; can exceed 90s
  // on slow LP-disclosure / endowment-990 PDFs.
  discover: 150_000,
  // Firmlist parses a single index page but follows up to 200 partner
  // links; the linkedin-public adapter in particular blocks on
  // sequential per-row fetches.
  firmlist: 150_000,
  // CSV imports are bounded by row count, not wall-clock; legitimate
  // 10k-row imports brush 120s in steady state.
  csv_import: 240_000,
  // Heavy single-URL targets (long PDFs, multi-MB HTML) — still
  // bounded, just not at 90s.
  parse_file: 180_000,
  import_file: 180_000,
  // Task #10: single-URL scrape jobs. The tiered fetcher escalates
  // Direct -> Browser -> Proxy -> Wayback; each tier carries its own
  // ~20s ceiling, and slow hosts / long PDFs / proxy round-trips can
  // push a legitimate fetch past the 90s default and get it swept by
  // admin.sweep. Matched to the `parse_file` heavy single-URL budget;
  // still bounded, just not at 90s. The override only LIFTS the budget,
  // never lowers an operator-set per-job ceiling.
  url: 180_000,
});

export function budgetForPipeline(kind: string | null | undefined): number | null {
  if (!kind) return null;
  const v = PIPELINE_BUDGETS_MS[kind];
  return typeof v === "number" && v > 0 ? v : null;
}

/**
 * Combine a per-job budget (the `jobs.budget_ms` column, possibly
 * null for legacy rows) with the per-pipeline override and the
 * global default. The result is `max(jobBudget ?? default, override
 * ?? 0)` — overrides only LIFT the budget so an operator-set
 * intentionally-tight ceiling is never silently relaxed.
 */
export function effectiveBudgetMs(
  jobBudgetMs: number | null | undefined,
  kind: string | null | undefined,
): number {
  const base = jobBudgetMs == null || jobBudgetMs <= 0 ? DEFAULT_BUDGET_MS : jobBudgetMs;
  const override = budgetForPipeline(kind);
  return override != null && override > base ? override : base;
}
