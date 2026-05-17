// Task #3 OSINT workflows. Three classes:
//   OSINTResolveEntityWorkflow — runs all pivots for one entity (60s budget).
//   OSINTBatchWorkflow         — picks N stalest entities + dispatches resolve.
//   OSINTReverifyWorkflow      — sweeps active handles older than 90 days.

import type { Env } from "../types";
import { resolveEntity } from "./resolve";
import { reverifyDueHandles } from "./reverify";

interface WorkflowStep {
  do<T>(name: string, opts: { retries?: { limit: number; delay?: string; backoff?: "constant" | "linear" | "exponential" } }, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: string | number): Promise<void>;
}
interface WorkflowEvent<P> { payload: P }

export class OSINTResolveEntityWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ entityId: string; manualReviewOnly?: boolean }>, step: WorkflowStep): Promise<{ ok: true; summary: unknown }> {
    const { entityId, manualReviewOnly } = event.payload;
    const summary = await step.do("resolve", { retries: { limit: 1, backoff: "constant" } }, async () => {
      return resolveEntity(this.env, entityId, { totalBudgetMs: 60_000, manualReviewOnly });
    });
    return { ok: true, summary };
  }
}

export class OSINTBatchWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ limit?: number; staleDays?: number }>, step: WorkflowStep): Promise<{ ok: true; dispatched: number }> {
    const limit = event.payload?.limit ?? 25;
    const staleDays = event.payload?.staleDays ?? 30;
    const picked = await step.do("pick", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      const r = await this.env.DB.prepare(
        `SELECT e.id
           FROM u_entities e
           LEFT JOIN osint_entity_state s ON s.entity_id = e.id
          WHERE e.status = 'active' AND e.display_name IS NOT NULL
            AND (s.last_osint_run_at IS NULL
                 OR datetime(s.last_osint_run_at) < datetime('now', ?))
          ORDER BY (s.last_osint_run_at IS NULL) DESC, s.last_osint_run_at ASC, e.quality_score DESC
          LIMIT ?`,
      ).bind(`-${staleDays} days`, limit).all<{ id: string }>();
      return (r.results ?? []).map((x) => x.id);
    });
    let dispatched = 0;
    for (const entityId of picked) {
      await step.do(`resolve:${entityId}`, { retries: { limit: 1, backoff: "constant" } }, async () => {
        try {
          await resolveEntity(this.env, entityId, { totalBudgetMs: 45_000 });
          dispatched++;
        } catch (e) { console.warn("osint batch entity failed", entityId, (e as Error).message); }
      });
    }
    return { ok: true, dispatched };
  }
}

export class OSINTReverifyWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ limit?: number }>, step: WorkflowStep): Promise<{ ok: true; result: unknown }> {
    const limit = event.payload?.limit ?? 200;
    const result = await step.do("reverify", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      return reverifyDueHandles(this.env, { limit, maxAgeDays: 90 });
    });
    return { ok: true, result };
  }
}
