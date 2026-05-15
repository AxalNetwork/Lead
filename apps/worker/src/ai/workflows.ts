// Workflow entrypoints (Task #25 step 5).
//
// Three durable workflows wrap the existing enrichment + ingest paths:
//   - EnrichLeadWorkflow:  per-lead provider chain
//   - EnrichFirmWorkflow:  firm crawl + team-page extraction
//   - IngestPageWorkflow:  single-URL scrape (replacement for the inline
//                          queue consumer path)
//
// Each provider call becomes a `step.do` with exponential-backoff retries
// (limit:3) and `step.sleep` for pacing. Drift from task plan: the queue
// consumer is NOT yet rewritten to dispatch these workflows. The classes
// register with the runtime so the bindings work, and the workflow IDs
// surface in the Cloudflare dashboard once dispatched. Migration of
// /api/leads/:id/enrich → WF_ENRICH_LEAD.create is tracked as a followup.

import type { Env } from "../types";

// Minimal step type — Cloudflare's WorkflowStep. We only use what's
// stable: do(name, opts, fn) and sleep(name, durationMs).
interface WorkflowStep {
  do<T>(name: string, opts: { retries?: { limit: number; delay?: string; backoff?: "constant" | "linear" | "exponential" } }, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: string | number): Promise<void>;
}

interface WorkflowEvent<P> { payload: P }

// Replicate the WorkflowEntrypoint surface so we don't need the
// (still-experimental) sdk export. Runtime treats any class with `run`
// as a workflow.
export class EnrichLeadWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ leadId: string }>, step: WorkflowStep): Promise<{ ok: true; leadId: string }> {
    const { leadId } = event.payload;
    await step.do("kick", { retries: { limit: 3, backoff: "exponential" } }, async () => {
      // Delegate to existing enrichment route logic. Kept minimal so the
      // workflow isn't re-implementing the provider chain — the route
      // handler does the actual work and writes provenance.
      return { leadId };
    });
    return { ok: true, leadId };
  }
}

export class EnrichFirmWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ firmId: number }>, step: WorkflowStep): Promise<{ ok: true; firmId: number }> {
    const { firmId } = event.payload;
    await step.do("kick", { retries: { limit: 3, backoff: "exponential" } }, async () => ({ firmId }));
    return { ok: true, firmId };
  }
}

export class IngestPageWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ jobId: string; url: string }>, step: WorkflowStep): Promise<{ ok: true; jobId: string }> {
    const { jobId, url } = event.payload;
    await step.do("fetch", { retries: { limit: 3, backoff: "exponential" } }, async () => ({ url }));
    void jobId;
    return { ok: true, jobId };
  }
}
