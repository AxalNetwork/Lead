// enrichLead: run every configured provider against a lead in parallel,
// respecting daily budget caps and a 14d KV response cache; merge results;
// persist via LeadsRepo.updateLead so lead_history rows are written per
// changed field.

import type { Env } from "../types";
import type { Lead, LeadPatch } from "../db/leads.types";
import { LeadsRepo } from "../db/leads.repo";
import { ALL_PROVIDERS } from "./providers";
import { checkBudget, recordBlock, recordCall } from "./budget";
import { mergePatches, type ProviderPatch } from "./merger";
import { tagLead } from "../tax/tag";
import { envFloat, type EnrichResult, type Provider } from "./types";

export interface EnrichOptions {
  providers?: string[];     // restrict to a subset (by name)
  forceRefresh?: boolean;   // bypass KV cache
  // Task #54: lets the nightly sweep hand in a lead row it already loaded
  // in one batched read, so enrichLead skips its own per-lead getById.
  preloadedLead?: Lead;
}

export interface EnrichOutcome {
  leadId: string;
  providers_called: string[];
  providers_blocked: Array<{ provider: string; reason: string }>;
  providers_skipped: Array<{ provider: string; reason: string }>;
  fields_changed: number;
  source_by_field: Record<string, string>;
  cost_usd: number;
}

function cacheKey(provider: string, lead: Lead): string {
  // Stable keys per (provider, lead identity); use a pinned set so changes to
  // unrelated columns don't invalidate the entry.
  const id = lead.email || lead.linkedin_url || `${lead.name}|${lead.org}` || lead.id;
  return `enr:${provider}:${id}`;
}

async function runOneProvider(
  env: Env,
  provider: Provider,
  lead: Lead,
  forceRefresh: boolean,
): Promise<{ result: EnrichResult; cached: boolean }> {
  const ttlDays = Math.max(1, envFloat(env.ENRICHMENT_KV_TTL_DAYS, 14));
  const ttlSec = Math.floor(ttlDays * 86400);
  const key = cacheKey(provider.name, lead);

  if (!forceRefresh) {
    const cached = await env.SCRAPE_CACHE.get(key);
    if (cached) {
      try { return { result: JSON.parse(cached) as EnrichResult, cached: true }; } catch { /* fall through */ }
    }
  }

  // Free providers have no spend to cap, and checkBudget reads a cap of 0
  // as "disabled" — which silently refused every call to the only two
  // providers left after the paid ones were removed. See Provider.isFree.
  const cap = provider.dailyCapUsd(env);
  const budget = provider.isFree
    ? { allowed: true, spent: 0 }
    : await checkBudget(env.DB, provider.name, cap);
  if (!budget.allowed) {
    await recordBlock(env.DB, provider.name, cap === 0 ? "disabled" : "budget");
    return { result: { patch: {}, evidence_url: null, cost_usd: 0, ok: false, reason: "budget" }, cached: false };
  }

  const result = await provider.enrich(env, { lead });
  if (result.cost_usd > 0) await recordCall(env.DB, provider.name, result.cost_usd);

  // Cache only useful or definitive-no responses; transient errors should retry.
  if (result.ok || result.reason === "no_data" || result.reason === "missing_input") {
    await env.SCRAPE_CACHE.put(key, JSON.stringify(result), { expirationTtl: ttlSec });
  }
  return { result, cached: false };
}

export async function enrichLead(env: Env, leadId: string, opts: EnrichOptions = {}): Promise<EnrichOutcome> {
  const repo = new LeadsRepo(env.DB, env);
  const lead = opts.preloadedLead ?? await repo.getById(leadId);
  if (!lead) {
    return {
      leadId, providers_called: [], providers_blocked: [], providers_skipped: [],
      fields_changed: 0, source_by_field: {}, cost_usd: 0,
    };
  }

  const restrict = opts.providers && opts.providers.length ? new Set(opts.providers) : null;
  const candidates = ALL_PROVIDERS.filter((p) => (!restrict || restrict.has(p.name)) && p.isConfigured(env));
  const skipped: EnrichOutcome["providers_skipped"] = ALL_PROVIDERS
    .filter((p) => !p.isConfigured(env))
    .map((p) => ({ provider: p.name, reason: "missing_key" }));

  const settled = await Promise.allSettled(candidates.map((p) => runOneProvider(env, p, lead, !!opts.forceRefresh).then((r) => ({ p, ...r }))));

  const patches: ProviderPatch[] = [];
  const called: string[] = [];
  const blocked: EnrichOutcome["providers_blocked"] = [];
  let cost = 0;
  for (const s of settled) {
    if (s.status !== "fulfilled") continue;
    const { p, result } = s.value;
    cost += result.cost_usd;
    if (result.ok) {
      called.push(p.name);
      patches.push({ provider: p.name, priority: p.priority, patch: result.patch });
    } else if (result.reason === "budget") {
      blocked.push({ provider: p.name, reason: "budget" });
    } else if (result.reason === "missing_key") {
      skipped.push({ provider: p.name, reason: "missing_key" });
    } else {
      skipped.push({ provider: p.name, reason: result.reason ?? "no_data" });
    }
  }

  const locks: string[] = lead.locked_fields_json ? safeArr(lead.locked_fields_json) : [];
  const merged = mergePatches(lead, patches, locks);

  // Record the merged patch via the audit-aware repo (one history row per field).
  // Use the field's *primary* source as the history `source` for that field.
  let totalChanged = 0;
  for (const [field, src] of Object.entries(merged.sourceByField)) {
    const fieldPatch = { [field]: (merged.patch as Record<string, unknown>)[field] } as unknown as LeadPatch;
    const hit = patches.find((pp) => src.startsWith(pp.provider));
    const evidence = hit ? "enrichment:" + hit.provider : "enrichment";
    const n = await repo.updateLead(lead.id, fieldPatch, { source: src, evidence_url: evidence });
    totalChanged += n;
  }

  // Stamp last_enriched_at + log even if nothing changed, so the cron can advance.
  const now = new Date().toISOString();
  const log = {
    at: now,
    cost_usd: Number(cost.toFixed(4)),
    called, blocked, skipped, fields_changed: totalChanged,
  };
  await env.DB
    .prepare("UPDATE leads SET last_enriched_at = ?, enrichment_log_json = ?, updated_at = ? WHERE id = ?")
    .bind(now, JSON.stringify(log), now, lead.id)
    .run();

  // Re-tag taxonomy slugs in case enrichment populated location/sector fields.
  // Best-effort: don't fail enrichment if tagging hits a transient error.
  try { await tagLead(env, lead.id, { source: "enrichment:tagger" }); } catch { /* non-fatal */ }

  // Task #2: trigger news refresh for the unified entity backing this lead.
  // Best-effort: prefer the workflow binding (so it runs out-of-band), fall
  // back to an inline refresh for dev environments without workflows.
  try {
    const map = await env.DB.prepare(
      `SELECT entity_id FROM entity_legacy_map WHERE legacy_table = 'leads' AND legacy_id = ?1 LIMIT 1`,
    ).bind(String(lead.id)).first<{ entity_id: string }>();
    if (map?.entity_id) {
      if (env.WF_REFRESH_NEWS) {
        await env.WF_REFRESH_NEWS.create({ params: { entityId: map.entity_id, triggered_by: "enrich:" + lead.id } });
      } else {
        const { refreshEntityNews } = await import("../news/refresh");
        await refreshEntityNews(env, map.entity_id, { maxArticles: 15 });
      }
    }
  } catch (e) { console.warn("enrich news refresh skipped", lead.id, (e as Error).message); }

  return {
    leadId: lead.id,
    providers_called: called,
    providers_blocked: blocked,
    providers_skipped: skipped,
    fields_changed: totalChanged,
    source_by_field: merged.sourceByField,
    cost_usd: Number(cost.toFixed(4)),
  };
}

function safeArr(s: string | null): string[] {
  if (!s) return [];
  try { const j = JSON.parse(s); return Array.isArray(j) ? j.map(String) : []; } catch { return []; }
}
