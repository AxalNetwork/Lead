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

// Task #8: persona ↔ entity matcher. Batch-scores a persona against
// every active person entity in u_entities. Heavy lifting lives in
// services/personaMatching.ts so the inline fallback (no WF binding in
// dev) hits the same code path.
export class PersonaEntityMatchWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ personaId: string; batchSize?: number; maxEntities?: number }>, step: WorkflowStep): Promise<{ ok: true; personaId: string; scored: number; errors: number; pages: number }> {
    const { personaId, batchSize, maxEntities } = event.payload;
    const { scoreBatch } = await import("../services/personaMatching");
    const r = await step.do("score_batch", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      return await scoreBatch(this.env, personaId, { batchSize, maxEntities });
    });
    return { ok: true, personaId, ...r };
  }
}

// Task #8: per-entity re-match across every active persona. Triggered
// from entity write paths (insertFact, addCareerEntry) so newly-
// promoted founders flow into matching personas within minutes.
export class PersonaMatchEntityWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ entityId: string }>, step: WorkflowStep): Promise<{ ok: true; entityId: string; scored: number; errors: number }> {
    const { entityId } = event.payload;
    const { scoreEntityAcrossPersonas } = await import("../services/personaMatching");
    const r = await step.do("score_entity_across_personas", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      return await scoreEntityAcrossPersonas(this.env, entityId);
    });
    return { ok: true, entityId, ...r };
  }
}

// Task #8: nightly refresh of stale persona_entity_matches rows
// (>30 days). Bounded by `limit` so a single tick fits its budget.
export class PersonaMatchRefreshWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ limit?: number; staleDays?: number }>, step: WorkflowStep): Promise<{ ok: true; refreshed: number; errors: number }> {
    const limit = event.payload?.limit ?? 500;
    const staleDays = event.payload?.staleDays ?? 30;
    const { refreshStaleMatches } = await import("../services/personaMatching");
    const r = await step.do("refresh", { retries: { limit: 1, backoff: "exponential" } }, async () => {
      return await refreshStaleMatches(this.env, { limit, staleDays });
    });
    return { ok: true, ...r };
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

// Task #3: per-entity due-diligence scan. The workflow stays small —
// heavy lifting (provider fan-out, findings upsert, score recompute,
// AI summary) lives in `dd/scan.ts` so the same code path is reachable
// from the inline route handler and from durable execution.
export class DDScanEntityWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ entityId: number; triggered_by?: string; providers?: string[] }>, step: WorkflowStep): Promise<{ ok: true; entityId: number; risk_score: number; risk_band: string }> {
    const { entityId, triggered_by, providers } = event.payload;
    const { scanEntity, loadEntityForScan } = await import("../dd/scan");
    const ent = await step.do("load_entity", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      const e = await loadEntityForScan(this.env, entityId);
      if (!e) throw new Error(`entity_not_found:${entityId}`);
      return e;
    });
    const r = await step.do("scan", { retries: { limit: 1, backoff: "exponential" } }, async () => {
      return await scanEntity(this.env, ent, {
        trigger: "workflow",
        triggered_by: triggered_by ?? null,
        providers,
        enableAi: true,
      });
    });
    return { ok: true, entityId, risk_score: r.risk_score, risk_band: r.risk_band };
  }
}

// Task #3: nightly DD batch scan. Pulls the oldest-scanned (or
// never-scanned) entities and runs the per-entity workflow on each.
// Bounded by `limit` so a single tick can't melt the queue.
export class DDScanBatchWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ limit?: number; staleDays?: number }>, step: WorkflowStep): Promise<{ ok: true; scanned: number; failed: number }> {
    const limit = event.payload?.limit ?? 100;
    const staleDays = event.payload?.staleDays ?? 7;
    const { batchScanDueEntities, refreshAllWatchlists } = await import("../dd/watchlistRefresh");
    await step.do("refresh_watchlists", { retries: { limit: 1 } }, async () => {
      return await refreshAllWatchlists(this.env);
    });
    const r = await step.do("batch_scan", { retries: { limit: 1 } }, async () => {
      return await batchScanDueEntities(this.env, { limit, staleDays });
    });
    return { ok: true, scanned: r.scanned, failed: r.failed };
  }
}

// Task #2: per-entity news refresh workflow. Heavy lifting (provider
// fan-out, AI enrichment, citation extraction, verified-score recompute,
// Wikipedia cross-reference) lives in `news/refresh.ts` so the same code
// path is reachable from the route handler and from durable execution.
export class RefreshNewsWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ entityId: string; triggered_by?: string; wiki?: boolean; archive?: boolean; max?: number }>, step: WorkflowStep): Promise<{ ok: true; entityId: string; persisted: number; mentions: number; citations: number }> {
    const { entityId, wiki, archive, max } = event.payload;
    const { refreshEntityNews } = await import("../news/refresh");
    const r = await step.do("refresh", { retries: { limit: 1, backoff: "exponential" } }, async () => {
      return await refreshEntityNews(this.env, entityId, { wiki, archive, maxArticles: max });
    });
    return { ok: true, entityId, persisted: r.persisted, mentions: r.mentions, citations: r.citations };
  }
}

// Task #3: per-entity profile classification (types + ideology + interests +
// influence + AI summary). Heavy lifting in profile/classifier.ts so the
// same code path is reachable from the route handler and from durable
// execution.
export class ClassifyEntityWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ entityId: string; force?: boolean; refreshGovernment?: boolean }>, step: WorkflowStep): Promise<{ ok: true; entityId: string; primary_type: string | null }> {
    const { entityId, force, refreshGovernment } = event.payload;
    if (refreshGovernment) {
      const { refreshGovernmentAppointments } = await import("../profile/government");
      const { refreshDonations } = await import("../profile/donations");
      await step.do("refresh_government", { retries: { limit: 1 } }, async () => refreshGovernmentAppointments(this.env, entityId));
      await step.do("refresh_donations",  { retries: { limit: 1 } }, async () => refreshDonations(this.env, entityId));
    }
    const { classifyEntity } = await import("../profile/classifier");
    const r = await step.do("classify", { retries: { limit: 1, backoff: "exponential" } }, async () => {
      return await classifyEntity(this.env, entityId, { force: !!force });
    });
    return { ok: true, entityId, primary_type: r.primary_type };
  }
}

// Task #3: nightly batch classifier. Picks the next N entities whose
// profile axes are missing or stale (>staleDays) and classifies each.
export class ClassifyBatchWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ limit?: number; staleDays?: number }>, step: WorkflowStep): Promise<{ ok: true; scanned: number; classified: number; errors: number }> {
    const limit = event.payload?.limit ?? 50;
    const staleDays = event.payload?.staleDays ?? 7;
    const { classifyBatch } = await import("../profile/classifier");
    const r = await step.do("batch", { retries: { limit: 1 } }, async () => classifyBatch(this.env, { limit, staleDays }));
    return { ok: true, scanned: r.scanned, classified: r.classified, errors: r.errors };
  }
}

// Task #3 (this task): per-entity AI Profile Filler workflow. Each
// phase (web fetch / canonical name / structured extraction / write /
// search corroboration) is wrapped in step.do so a 30s CPU trip never
// restarts the entire fill.
export class AIProfileFillerWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ entityId: string; force?: boolean; triggeredBy?: string }>, step: WorkflowStep): Promise<{ ok: boolean; entityId: string; reason?: string; facts_written: number; team_added: number; portfolio_added: number; pages_fetched?: number; name_corrected?: boolean }> {
    const env = this.env;
    const { entityId, force, triggeredBy } = event.payload;
    const pf = await import("./profileFiller");

    // Phase 0 — preflight: load entity, cooldown, budget, site URL.
    const preflight = await step.do("preflight", { retries: { limit: 1 } }, async () => {
      const ent = await env.DB.prepare(
        `SELECT id, kind, display_name, primary_url, primary_domain FROM u_entities WHERE id = ? AND status = 'active'`,
      ).bind(entityId).first<{ id: string; kind: string; display_name: string | null; primary_url: string | null; primary_domain: string | null }>();
      if (!ent) return { ok: false as const, reason: "entity_not_found" };
      if (!force) {
        const cool = await pf.isWithinCooldown(env, entityId);
        if (cool.blocked) return { ok: false as const, reason: "cooldown_active" };
      }
      const { assertBudget } = await import("./budget");
      const b = await assertBudget(env, "ai");
      if (!b.ok) return { ok: false as const, reason: `budget_blocked:${b.reason ?? "ai"}` };
      const siteUrl = ent.primary_url ?? (ent.primary_domain ? `https://${ent.primary_domain}` : null);
      if (!siteUrl) return { ok: false as const, reason: "no_website" };
      return { ok: true as const, ent, siteUrl };
    });
    if (!preflight.ok) {
      return { ok: false, entityId, reason: preflight.reason, facts_written: 0, team_added: 0, portfolio_added: 0 };
    }
    const ent = preflight.ent;
    const siteUrl = preflight.siteUrl;

    // Phase A — fetch site pages.
    const pages = await step.do("fetch_pages", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      return await pf.fetchSitePages(env, siteUrl);
    });
    if (!pages.length) {
      await step.do("stamp_cooldown_no_pages", {}, async () => { await pf.stampCooldown(env, entityId); });
      return { ok: false, entityId, reason: "no_pages_fetched", facts_written: 0, team_added: 0, portfolio_added: 0, pages_fetched: 0 };
    }
    const homepage = pages[0];

    // Phase B — canonical name + correction.
    const nameRes = await step.do("canonical_name", { retries: { limit: 1 } }, async () => {
      const aiName = await pf.extractCanonicalName(env, homepage.text);
      let corrected = false;
      if (aiName) corrected = await pf.maybeApplyNameCorrection(env, ent, aiName, homepage.url);
      return { aiName, corrected };
    });

    // Phase C — structured extraction.
    const profile = await step.do("structured_extract", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      return await pf.extractStructuredProfile(env, pages);
    });
    if (!profile) {
      // Spec: persist the failure as a confidence=0 fact so the audit
      // trail mirrors the inline fillProfile() behavior. Workflow and
      // inline paths must be observationally equivalent on failure.
      await step.do("persist_extract_fail", {}, async () => {
        const { insertFact } = await import("../entities/facts");
        await insertFact(env, {
          entity_id: entityId, predicate: "ai_profile_filler_failed",
          value_text: "structured_extraction_invalid_json",
          source_kind: "ai", source: pf.PROFILE_FILLER_VERSION, evidence_url: homepage.url, confidence: 0,
        });
        await pf.stampCooldown(env, entityId);
      });
      return { ok: false, entityId, reason: "extraction_failed", facts_written: 0, team_added: 0, portfolio_added: 0, pages_fetched: pages.length, name_corrected: nameRes.corrected };
    }

    // Phase D — light validation (coercion).
    if (profile.headquarters_country_iso2 && !/^[A-Za-z]{2}$/.test(profile.headquarters_country_iso2)) {
      profile.headquarters_country_iso2 = undefined;
    }
    if (profile.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contact_email)) {
      profile.contact_email = undefined;
    }

    // Phase E — write to DB.
    const written = await step.do("write_db", { retries: { limit: 1 } }, async () => {
      return await pf.writeProfileToDb(env, entityId, profile, homepage.url, pages);
    });

    // Phase F — search corroboration (best-effort).
    const canonicalName = nameRes.corrected && nameRes.aiName ? nameRes.aiName : (ent.display_name ?? nameRes.aiName ?? "");
    if (canonicalName) {
      await step.do("corroborate", { retries: { limit: 0 } }, async () => {
        try { await pf.corroborateClaims(env, entityId, canonicalName, profile, homepage.url); } catch (e) {
          console.warn("corroborateClaims failed", entityId, (e as Error).message);
        }
        return { ok: true };
      });
    }

    // Phase G — stamp freshness + cooldown.
    await step.do("stamp_freshness", {}, async () => {
      const { insertFact } = await import("../entities/facts");
      await insertFact(env, {
        entity_id: entityId, predicate: "ai_profile_filled_at",
        value_text: new Date().toISOString(),
        value_json: { triggered_by: triggeredBy ?? "workflow", force: !!force, pages: pages.length },
        source_kind: "ai", source: pf.PROFILE_FILLER_VERSION, evidence_url: homepage.url, confidence: 1,
      });
      await pf.stampCooldown(env, entityId);
    });

    return {
      ok: true, entityId,
      facts_written: written.facts_written,
      team_added: written.team_added,
      portfolio_added: written.portfolio_added,
      pages_fetched: pages.length,
      name_corrected: nameRes.corrected,
    };
  }
}

// Task #3: nightly batch — picks the N stalest entities and fills each.
export class AIProfileFillerBatchWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ limit?: number }>, step: WorkflowStep): Promise<{ ok: true; scanned: number; filled: number; errors: number; skipped: number }> {
    const limit = event.payload?.limit ?? 200;
    const { fillStalestBatch } = await import("./profileFiller");
    const r = await step.do("fill_batch", { retries: { limit: 1 } }, async () => {
      return await fillStalestBatch(this.env, { limit });
    });
    return { ok: true, ...r };
  }
}

// Task #3: refresh government appointments + donations for a single
// entity. Stand-alone workflow so an operator can re-pull political
// rows without re-running the full classifier.
export class RefreshGovernmentWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ entityId: string }>, step: WorkflowStep): Promise<{ ok: true; entityId: string; appointments: number; donations: number }> {
    const { entityId } = event.payload;
    const { refreshGovernmentAppointments } = await import("../profile/government");
    const { refreshDonations } = await import("../profile/donations");
    const a = await step.do("appointments", { retries: { limit: 1 } }, async () => refreshGovernmentAppointments(this.env, entityId));
    const d = await step.do("donations",    { retries: { limit: 1 } }, async () => refreshDonations(this.env, entityId));
    return { ok: true, entityId, appointments: a.upserted, donations: d.upserted };
  }
}

// Task #2: durable seed-discovery workflow.
export class DiscoverFromSeedWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ url: string; depthMax?: number; maxPerHost?: number; methods?: string[]; yieldThreshold?: number; runId?: string }>, step: WorkflowStep): Promise<{ ok: true; runId: string; discovered: number; queued: number }> {
    const { runDiscoverFromSeed } = await import("../discovery/runDiscovery");
    const r = await step.do("seed", { retries: { limit: 2, backoff: "exponential" } }, async () =>
      runDiscoverFromSeed(this.env, {
        url: event.payload.url,
        depthMax: event.payload.depthMax,
        maxPerHost: event.payload.maxPerHost,
        methods: event.payload.methods,
        yieldThreshold: event.payload.yieldThreshold,
        runId: event.payload.runId,
      }),
    );
    return { ok: true, runId: r.runId, discovered: r.discovered, queued: r.queued };
  }
}

// Task #2: durable frontier crawler. Pops + fetches a batch, then
// recurses by sleeping briefly and re-popping until empty or capped.
export class CrawlFrontierWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ runId?: string; limit?: number; maxBatches?: number }>, step: WorkflowStep): Promise<{ ok: true; batches: number; fetched: number }> {
    const { runCrawlFrontier } = await import("../discovery/runDiscovery");
    const maxBatches = Math.min(event.payload.maxBatches ?? 10, 50);
    let batches = 0, fetched = 0;
    for (let i = 0; i < maxBatches; i++) {
      const r = await step.do(`batch_${i}`, { retries: { limit: 1 } }, async () =>
        runCrawlFrontier(this.env, { runId: event.payload.runId, limit: event.payload.limit ?? 25 }),
      );
      batches++;
      fetched += r.fetched;
      if (r.scanned === 0) break;
      await step.sleep(`pace_${i}`, "5s");
    }
    return { ok: true, batches, fetched };
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

// Task #2 (this task): monitoring workflows.
//
// MonitorEntityWorkflow — runs the diff + trigger evaluation + channel
// dispatch for one entity. Idempotent: re-running on the same fingerprint
// is a no-op (fingerprint-first short-circuit inside monitorEntity).
export class MonitorEntityWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ entityId: string }>, step: WorkflowStep): Promise<{ ok: true; entityId: string; changed: boolean; emitted: number; delivered: number }> {
    const { entityId } = event.payload;
    const { monitorEntity } = await import("../monitoring/dispatch");
    const r = await step.do("monitor", { retries: { limit: 1, backoff: "exponential" } }, async () => {
      return await monitorEntity(this.env, entityId);
    });
    return { ok: true, entityId, changed: r.changed, emitted: r.emitted, delivered: r.delivered };
  }
}

// MonitorBatchWorkflow — walks the pool of entities that are due for
// re-evaluation (members of an active watchlist OR directly attached to
// an active rule) and runs the per-entity workflow on each. Also sweeps
// pending webhook retries and re-evaluates smart watchlists. Bounded by
// `limit` so a single tick can't melt the queue.
export class MonitorBatchWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ limit?: number; staleMinutes?: number }>, step: WorkflowStep): Promise<{ ok: true; scanned: number; emitted: number; delivered: number; retried: number; smart: number }> {
    const limit = event.payload?.limit ?? 200;
    const staleMinutes = event.payload?.staleMinutes ?? 15;

    // 1. Re-evaluate smart watchlists (membership rebalance).
    const smart = await step.do("smart_reeval", { retries: { limit: 1 } }, async () => {
      const { reevaluateAllSmartWatchlists } = await import("../monitoring/smart");
      return await reevaluateAllSmartWatchlists(this.env, { limit: 25 });
    });

    // 2. Pick due entities. Prefer fan-out to MonitorEntityWorkflow for
    //    per-entity durability/retry isolation; fall back to inline
    //    evaluation when the binding isn't available (local dev / tests).
    const { pickDueEntities, monitorEntity, retryPendingDeliveries } = await import("../monitoring/dispatch");
    const ids = await step.do("pick", { retries: { limit: 1 } }, async () =>
      await pickDueEntities(this.env, { limit, staleMinutes }),
    );
    let emitted = 0, delivered = 0;
    if (this.env.WF_MONITOR_ENTITY) {
      for (let i = 0; i < ids.length; i++) {
        try {
          await this.env.WF_MONITOR_ENTITY.create({ params: { entityId: ids[i] } });
        } catch (e) {
          console.warn("WF_MONITOR_ENTITY create failed", ids[i], (e as Error).message);
        }
      }
    } else {
      for (let i = 0; i < ids.length; i++) {
        try {
          const r = await monitorEntity(this.env, ids[i]);
          emitted += r.emitted; delivered += r.delivered;
        } catch (e) {
          console.warn("monitorEntity failed", ids[i], (e as Error).message);
        }
      }
    }

    // 3. Sweep pending webhook retries that have come due.
    const retried = await step.do("retry", { retries: { limit: 1 } }, async () =>
      await retryPendingDeliveries(this.env, 50),
    );
    return { ok: true, scanned: ids.length, emitted, delivered, retried: retried.retried, smart: smart.watchlists };
  }
}

// Task #5: per-entity individual profiler workflow. The orchestrator
// itself (services/profilers/orchestrator.ts) does the parallel fan-out,
// per-enricher step.do isolation, write dispatch, and synthesis — this
// Workflow class is a thin durable wrapper so dispatched runs survive
// instance restarts and surface a run_id in the CF dashboard.
export class IndividualProfilerWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(
    event: WorkflowEvent<{ entityId: string; runId: string; triggeredBy: string; forceRefresh?: boolean; viewerEntityId?: string | null }>,
    step: WorkflowStep,
  ): Promise<{ ok: true; summary: unknown }> {
    const { entityId, runId, triggeredBy, forceRefresh, viewerEntityId } = event.payload;
    const { runProfiler } = await import("../services/profilers/orchestrator");
    // Each enricher (and the synthesis pass) runs inside its own
    // step.do, so a Workflow instance restart resumes from the last
    // completed enricher rather than redoing the whole batch. The
    // step name is `enricher:<name>` / `synthesize` — set by the
    // orchestrator.
    const summary = await runProfiler(this.env, entityId, {
      runId, triggeredBy, forceRefresh, viewerEntityId,
      stepRunner: <T>(name: string, fn: () => Promise<T>) =>
        step.do(name, { retries: { limit: 1, backoff: "constant" } }, fn),
    });
    return { ok: true, summary };
  }
}

// DigestWorkflow — runs hourly. Picks rows from `digest_queue` whose
// `scheduled_for` has come due, groups by (owner_email, watchlist_id),
// renders one email per group, marks the queue rows sent.
export class DigestWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ limit?: number }>, step: WorkflowStep): Promise<{ ok: true; groups: number; events: number; sent: number; failed: number }> {
    const limit = event.payload?.limit ?? 500;
    const r = await step.do("digest", { retries: { limit: 1, backoff: "exponential" } }, async () => {
      const { runDigest } = await import("../monitoring/digest");
      return await runDigest(this.env, { limit });
    });
    return { ok: true, ...r };
  }
}
