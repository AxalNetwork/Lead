// Task #3: Investor name resolution.
//
// Mirrors services/fundResolver.ts for investor firms (VCs, PE, family
// offices, corporate VCs, angels-as-firms). Every investor name in a
// deal candidate runs through resolveInvestor() — exact-normalized
// lookup against existing org entities tagged with one of:
//   role = 'investor_firm' | 'firm' | 'fund' | 'investor'
// On miss, mints a new org entity through the canonical createEntity
// path (NEVER a direct INSERT) with confidence=0.5 and queues the AI
// profile-filler workflow so a freshly-created investor gets enriched
// asynchronously.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import { createEntity, addRole } from "../../entities/roles";

const MATCH_THRESHOLD = 0.6;

export interface InvestorResolveResult {
  investor_entity_id: string | null;
  confidence: number;
  created: boolean;
  matched_by: "exact_name" | "exact_normalized" | "prefix" | "created" | "unresolved";
}

/** Investor-name normalizer. Looser than fundResolver because investor
 *  firm names rarely carry "L.P." / vintage suffixes but DO commonly
 *  carry "Ventures", "Capital", "Partners" tokens that should be
 *  preserved (they're disambiguating, not noise). */
export function normalizeInvestorName(raw: string): string {
  if (!raw) return "";
  let s = raw.toLowerCase().trim();
  s = s.replace(/^the\s+/, "");
  s = s.replace(/\([^)]*\)/g, " ");
  // Drop only the lightweight legal suffixes; KEEP ventures/capital/partners.
  s = s.replace(/\b(l\.?p\.?|llc|l\.?l\.?c\.?|ltd\.?|inc\.?|corp\.?|gmbh|s\.?a\.?|plc|bv|sas|sarl)\b/g, " ");
  s = s.replace(/[.,;:'"!?/\\&_]+/g, " ").replace(/\s+/g, " ").trim();
  return s;
}

interface InvestorCandidate {
  entity_id: string;
  display_name: string | null;
}

async function loadCandidates(env: Env, normalized: string): Promise<InvestorCandidate[]> {
  if (!normalized || normalized.length < 2) return [];
  // Prefer an indexed identifier-fact lookup; fall back to a bounded
  // LIKE if no normalized name fact exists yet.
  const exact = await env.DB.prepare(
    `SELECT entity_id FROM facts
      WHERE predicate = 'investor.name_normalized' AND value_text = ? AND is_current = 1
      LIMIT 25`,
  ).bind(normalized).all<{ entity_id: string }>();
  const ids = new Set<string>((exact.results ?? []).map((r) => r.entity_id));
  if (ids.size === 0) {
    const loose = await env.DB.prepare(
      `SELECT id, display_name FROM u_entities
        WHERE kind = 'org' AND status = 'active'
          AND lower(display_name) LIKE ?
        LIMIT 50`,
    ).bind(`%${normalized.slice(0, 40)}%`).all<{ id: string; display_name: string }>();
    for (const r of loose.results ?? []) ids.add(r.id);
  }
  if (ids.size === 0) return [];
  const placeholders = [...ids].map(() => "?").join(",");
  const rows = await env.DB.prepare(
    `SELECT e.id AS entity_id, e.display_name
       FROM u_entities e
      WHERE e.id IN (${placeholders})
        AND EXISTS (
          SELECT 1 FROM entity_roles r
           WHERE r.entity_id = e.id
             AND r.role IN ('investor_firm','firm','fund','investor')
        )`,
  ).bind(...ids).all<InvestorCandidate>();
  return rows.results ?? [];
}

/**
 * Resolve a raw investor-name string to an org entity. Creates a new
 * entity (confidence=0.5) through the canonical createEntity path when
 * no candidate clears MATCH_THRESHOLD, and enqueues the AI profile
 * filler workflow on the created entity so a downstream enrichment
 * pass populates thesis / sectors / portfolio.
 */
export async function resolveInvestor(
  env: Env,
  raw: string,
  ctx: { source: string; evidence_url?: string | null },
): Promise<InvestorResolveResult> {
  const name = (raw ?? "").trim();
  if (!name || name.length < 2) {
    return { investor_entity_id: null, confidence: 0, created: false, matched_by: "unresolved" };
  }
  const normalized = normalizeInvestorName(name);
  const candidates = await loadCandidates(env, normalized);
  let best: { c: InvestorCandidate; conf: number; matched_by: InvestorResolveResult["matched_by"] } | null = null;
  for (const c of candidates) {
    const cn = normalizeInvestorName(c.display_name ?? "");
    let conf = 0;
    let mb: InvestorResolveResult["matched_by"] = "prefix";
    if (cn && cn === normalized) {
      conf = 0.9; mb = "exact_normalized";
    } else if (cn && (cn.startsWith(normalized) || normalized.startsWith(cn))) {
      conf = 0.65; mb = "prefix";
    } else if ((c.display_name ?? "").toLowerCase() === name.toLowerCase()) {
      conf = 0.95; mb = "exact_name";
    }
    if (!best || conf > best.conf) best = { c, conf, matched_by: mb };
  }
  if (best && best.conf >= MATCH_THRESHOLD) {
    return {
      investor_entity_id: best.c.entity_id, confidence: best.conf,
      created: false, matched_by: best.matched_by,
    };
  }
  // Mint a new investor entity through the canonical path. createEntity
  // auto-dispatches WF_PROFILE_FILLER for orgs with website|domain;
  // here we have no website so we explicitly hand-roll the dispatch
  // below to keep the spec's "queue AI profile filler" guarantee.
  const row = await createEntity(env, {
    kind: "org",
    display_name: name.slice(0, 200),
    suppressAutoProfileFill: true,
  });
  await addRole(env, row.id, "investor_firm", {
    is_primary: true, source: ctx.source, confidence: 0.5,
  });
  const factCtx = {
    entity_id: row.id, source_kind: "scrape" as const, source: ctx.source,
    evidence_url: ctx.evidence_url ?? null, confidence: 0.5,
  };
  await insertFact(env, { ...factCtx, predicate: "investor.name_normalized", value_text: normalized });
  await insertFact(env, { ...factCtx, predicate: "investor.display_name", value_text: name });
  // Enqueue AI profile filler so the new investor gets enriched async.
  // Spec: "Unknown investor names are created with low confidence and
  // queued for the AI profile filler workflow."
  try {
    const wf = (env as Env & { WF_PROFILE_FILLER?: { create: (o: { params: Record<string, unknown> }) => Promise<{ id: string }> } }).WF_PROFILE_FILLER;
    if (wf) {
      void wf.create({
        params: { entityId: row.id, force: false, triggeredBy: "deal_extractor:new_investor" },
      }).catch(() => undefined);
    }
  } catch { /* best-effort */ }
  return {
    investor_entity_id: row.id, confidence: 0.5,
    created: true, matched_by: "created",
  };
}
