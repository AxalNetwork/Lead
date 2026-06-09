// Task #70: per-invocation subrequest budget for the crawl path.
//
// Cloudflare counts subrequests (outbound `fetch()` plus D1/KV/R2 binding
// calls) CUMULATIVELY across a single Worker invocation and throws "Too many
// subrequests by single Worker invocation" once the per-invocation ceiling is
// crossed. The queue consumer processes a whole batch of messages in ONE
// invocation, so the budget is shared across every job in that batch.
//
// This mirrors the budget already used by the legacy file-import path
// (`imports/import.ts`, SUBREQUEST_BUDGET = 700): estimate the cost of each
// unit of work, stop spending once the budget is near-exhausted, and let the
// remaining work be re-enqueued as a fresh job (a transient queue retry) rather
// than forced inline into an invocation that will only throw.
//
// The ceiling is deliberately the same 700 the import path uses. The dominant
// real-world blow-up was the tier-2 proxy-failover loop (up to 6 providers) plus
// Wayback escalation multiplying a single blocked URL into ~9 subrequests; with
// the batch size lowered and the failover made subrequest-aware, this budget is
// the hard safety ceiling that guarantees an invocation can never run past the
// platform cap.
export const CRAWL_SUBREQUEST_BUDGET = 700;

export class SubrequestBudget {
  private spentCount = 0;

  constructor(private readonly limit: number = CRAWL_SUBREQUEST_BUDGET) {}

  /** Record `n` subrequests as consumed (page fetches, R2 archive writes,
   *  D1 touchSource writes, fanout inserts, …). Negative values are ignored. */
  spend(n = 1): void {
    if (n > 0) this.spentCount += n;
  }

  /** Subrequests consumed so far this invocation. */
  get used(): number {
    return this.spentCount;
  }

  /** Subrequests still available before the ceiling. */
  get remaining(): number {
    return Math.max(0, this.limit - this.spentCount);
  }

  /** True when spending `cost` more subrequests would cross the ceiling.
   *  Callers MUST check this BEFORE firing the work so the over-budget
   *  subrequest is never made — once Cloudflare throws, the invocation is
   *  poisoned for every later subrequest too. */
  wouldExceed(cost = 1): boolean {
    return this.spentCount + Math.max(1, cost) > this.limit;
  }
}
