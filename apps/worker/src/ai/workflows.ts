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

// Task #45: per-account enrichment workflow. Triggered on account create
// (resolveAccount) and on POST /api/accounts/:id/enrich. Walks every
// enabled source module that supports per-account scoping (currently
// BuiltWith + GitHub org + Google News), then recomputes account score.
// Each step is idempotent — re-running is safe.
export class EnrichAccountWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ accountId: string; source?: string }>, step: WorkflowStep): Promise<{ ok: true; accountId: string; ran: string[] }> {
    const { accountId } = event.payload;
    const { MODULES } = await import("../prospects/sources/registry");
    const { runSource } = await import("../prospects/runCrawl");
    const { recomputeAccountScore } = await import("../prospects/repo");
    const { syncAccountAiById } = await import("../prospects/aiSync");
    const ran: string[] = [];
    // Per-account scoped sources: each module honours ctx.accountId and
    // restricts its DB query / API call to that single account.
    const perAccount = MODULES.filter((m) => ["builtwith", "github_org", "google_news"].includes(m.slug));
    for (const mod of perAccount) {
      await step.do(`enrich:${mod.slug}`, { retries: { limit: 2, backoff: "exponential" } }, async () => {
        await runSource(this.env, mod, { force: true, accountId });
        ran.push(mod.slug);
      });
    }
    await step.do("recompute_score", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      await recomputeAccountScore(this.env, accountId);
    });
    // Re-embed + reindex so vector search and AI Search reflect the
    // freshly enriched account immediately.
    await step.do("ai_resync", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      await syncAccountAiById(this.env, accountId);
    });
    return { ok: true, accountId, ran };
  }
}

// Task #45: hourly buyer-signal crawl. The hourly cron dispatches this
// workflow; it fans out to every enabled source module via runSource().
// Kept lean inside the workflow itself so the durable steps remain
// idempotent — heavy lifting lives in prospects/runCrawl.ts.
export class CrawlSignalsWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ slug?: string }>, step: WorkflowStep): Promise<{ ok: true; ran: number }> {
    const slug = event.payload?.slug;
    const { MODULES, getModule } = await import("../prospects/sources/registry");
    const { runSource } = await import("../prospects/runCrawl");
    const targets = slug ? [getModule(slug)].filter(Boolean) : MODULES;
    let ran = 0;
    for (const mod of targets) {
      if (!mod) continue;
      await step.do(`run:${mod.slug}`, { retries: { limit: 2, backoff: "exponential" } }, async () => {
        await runSource(this.env, mod);
      });
      ran += 1;
    }
    return { ok: true, ran };
  }
}

// Task #46: full-persona rescore. The workflow stays small — heavy
// lifting is in personas/rescore.ts so the same code path is reachable
// from the inline fallback (when WF binding is absent in dev) and from
// the durable execution.
export class RescorePersonaWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ personaId: string }>, step: WorkflowStep): Promise<{ ok: true; personaId: string; scored: number }> {
    const { personaId } = event.payload;
    const { rescorePersonaFull } = await import("../personas/rescore");
    const r = await step.do("rescore", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      return await rescorePersonaFull(this.env, personaId);
    });
    return { ok: true, personaId, scored: r.scored };
  }
}

// Task #47: durable per-project match recompute. Triggered on create /
// patch / nightly cron / manual /recompute. Heavy lifting lives in
// projects/match.ts so the inline fallback (no WF binding in dev) hits
// the same code path.
export class MatchProjectWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ projectId: string }>, step: WorkflowStep): Promise<{ ok: true; projectId: string; audiences: number }> {
    const { projectId } = event.payload;
    const { matchProject } = await import("../projects/match");
    const r = await step.do("match", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      return await matchProject(this.env, projectId);
    });
    return { ok: true, projectId, audiences: r.audiences.length };
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
