// Task #47: project matching engine.
//
// Combines per-audience persona matches + direct semantic search +
// audience-specific overlays. Final score:
//   final = 0.4*persona + 0.4*semantic + 0.2*overlay
//
// Pure module — no DB / network access. The match orchestrator
// (./match.ts) is responsible for loading facts and persisting rows.

export type Audience = "customer" | "investor" | "partner" | "hire" | "design_partner";
export const AUDIENCES: Audience[] = ["customer", "investor", "partner", "hire", "design_partner"];

export interface ProjectSpec {
  id: string;
  name: string;
  one_liner: string | null;
  description: string | null;
  problems_solved: string | null;
  unique_value: string | null;
  stage: string | null;
  funding_status: string | null;
  funding_target: number | null;
  target_industries: string[];
  target_geos: string[];
  target_customer_size_bands: string[];
  audiences: Partial<Record<Audience, boolean>>;
  persona_ids: Record<Audience, string[]>;
}

export interface AudienceCandidate {
  entity_kind: "account" | "buyer" | "firm" | "company" | "lead";
  entity_id: string;
  // Pre-computed inputs:
  persona_score: number | null;       // 0..100 (max persona_matches.fit_score across attached personas)
  semantic_cosine: number | null;     // -1..1 (later mapped to 0..100)
  // Audience-specific facts (loaded by orchestrator)
  facts: Record<string, unknown>;
}

export interface AudienceMatchResult {
  entity_kind: AudienceCandidate["entity_kind"];
  entity_id: string;
  fit_score: number;
  persona_score: number;
  semantic_score: number;
  overlay_score: number;
  components: Record<string, unknown>;
}

function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function clamp100(n: number): number { return Math.max(0, Math.min(100, n)); }

function semanticToScore(c: number | null): number {
  if (c == null) return 0;
  // bge cosine on related text typically lands 0.45..0.85; rescale to 0..100.
  const lo = 0.45, hi = 0.85;
  return clamp100(((c - lo) / (hi - lo)) * 100);
}

// ---------- audience overlays ----------

// Customer: intent + recent buying signals on the account/lead.
function overlayCustomer(c: AudienceCandidate): { score: number; sub: Record<string, number> } {
  const f = c.facts;
  const intent = Number((f.intent_score as number | undefined) ?? 0);                // 0..100 from accounts
  const recent = Number((f.recent_signal_count as number | undefined) ?? 0);          // signals last 30d
  const intentS = clamp100(intent);
  const recentS = clamp100(Math.min(recent, 10) * 10);
  const score = clamp100(0.6 * intentS + 0.4 * recentS);
  return { score, sub: { intent: intentS, recent_signals: recentS } };
}

// Investor: stage overlap + sector overlap + check-size fit.
function overlayInvestor(c: AudienceCandidate, p: ProjectSpec): { score: number; sub: Record<string, number> } {
  const f = c.facts;
  const stages: string[] = Array.isArray(f.stages) ? (f.stages as string[]) : [];
  const sectors: string[] = Array.isArray(f.sectors) ? (f.sectors as string[]) : [];
  const checkMin = Number((f.check_min as number | undefined) ?? 0);
  const checkMax = Number((f.check_max as number | undefined) ?? 0);

  const idealCheck = (p.funding_target ?? 0) / 10;
  const stageS = p.funding_status && stages.includes(p.funding_status) ? 100 : (stages.length ? 30 : 50);
  const sectorOverlap = p.target_industries.filter((i) => sectors.includes(i)).length;
  const sectorS = p.target_industries.length
    ? clamp100((sectorOverlap / p.target_industries.length) * 100)
    : 50;
  let checkS = 50;
  if (checkMin > 0 && checkMax > 0 && idealCheck > 0) {
    if (idealCheck >= checkMin && idealCheck <= checkMax) checkS = 100;
    else {
      const dist = idealCheck < checkMin ? (checkMin - idealCheck) / checkMin : (idealCheck - checkMax) / checkMax;
      checkS = clamp100(100 - clamp01(dist) * 100);
    }
  }
  const score = clamp100(0.4 * stageS + 0.3 * sectorS + 0.3 * checkS);
  return { score, sub: { stage_overlap: stageS, sector_overlap: sectorS, check_fit: checkS } };
}

// Partner: same-ICP companies that aren't competitors.
function overlayPartner(c: AudienceCandidate, p: ProjectSpec): { score: number; sub: Record<string, number> } {
  const f = c.facts;
  const isCompetitor = (f.is_competitor as boolean | undefined) ?? false;
  const sharedIcp = Number((f.shared_icp_count as number | undefined) ?? 0); // count of overlapping ICP attributes
  const competeS = isCompetitor ? 0 : 100;
  const icpS = clamp100(Math.min(sharedIcp, 5) * 20);
  const score = clamp100(0.5 * competeS + 0.5 * icpS);
  void p;
  return { score, sub: { not_competitor: competeS, shared_icp: icpS } };
}

// Hire: prior-experience overlap + seniority match.
function overlayHire(c: AudienceCandidate): { score: number; sub: Record<string, number> } {
  const f = c.facts;
  const sharedIndustries = Number((f.shared_industries as number | undefined) ?? 0);
  const seniorityMatch = Boolean((f.seniority_match as boolean | undefined) ?? false);
  const expS = clamp100(Math.min(sharedIndustries, 3) * 33);
  const senS = seniorityMatch ? 100 : 40;
  const score = clamp100(0.5 * expS + 0.5 * senS);
  return { score, sub: { prior_experience: expS, seniority_match: senS } };
}

// Design partner: customer overlay × early-adopter signal.
function overlayDesignPartner(c: AudienceCandidate, p: ProjectSpec): { score: number; sub: Record<string, number> } {
  const cust = overlayCustomer(c);
  const f = c.facts;
  const earlyAdopter = Number((f.early_adopter_score as number | undefined) ?? 0);   // 0..100
  const earlyS = clamp100(earlyAdopter);
  const score = clamp100(0.6 * cust.score + 0.4 * earlyS);
  void p;
  return { score, sub: { ...cust.sub, early_adopter: earlyS } };
}

export function overlayFor(audience: Audience, c: AudienceCandidate, p: ProjectSpec): { score: number; sub: Record<string, number> } {
  switch (audience) {
    case "customer":        return overlayCustomer(c);
    case "investor":        return overlayInvestor(c, p);
    case "partner":         return overlayPartner(c, p);
    case "hire":            return overlayHire(c);
    case "design_partner":  return overlayDesignPartner(c, p);
  }
}

export function scoreCandidate(audience: Audience, p: ProjectSpec, c: AudienceCandidate): AudienceMatchResult {
  const personaS = clamp100(c.persona_score ?? 0);
  const semanticS = semanticToScore(c.semantic_cosine);
  const ov = overlayFor(audience, c, p);
  const final = clamp100(0.4 * personaS + 0.4 * semanticS + 0.2 * ov.score);
  return {
    entity_kind: c.entity_kind,
    entity_id: c.entity_id,
    fit_score: final,
    persona_score: personaS,
    semantic_score: semanticS,
    overlay_score: ov.score,
    components: {
      ...ov.sub, persona: personaS, semantic: semanticS, overlay: ov.score,
      // Forward the entity's last_modified so the pitch cache key can
      // invalidate when the underlying entity changes; forward country
      // so /matches?country= and the workspace tag can filter without a
      // second DB hop.
      last_modified: (c.facts as Record<string, unknown>)?.last_modified ?? null,
      country: (c.facts as Record<string, unknown>)?.country ?? null,
    },
  };
}

export function buildEmbeddingText(p: ProjectSpec): string {
  const parts: string[] = [];
  parts.push(p.name);
  if (p.one_liner) parts.push(p.one_liner);
  if (p.description) parts.push(p.description.slice(0, 1500));
  if (p.problems_solved) parts.push(`Problems: ${p.problems_solved}`);
  if (p.unique_value) parts.push(`Edge: ${p.unique_value}`);
  if (p.stage) parts.push(`Stage: ${p.stage}`);
  if (p.target_industries.length) parts.push(`Industries: ${p.target_industries.join(", ")}`);
  if (p.target_geos.length) parts.push(`Geos: ${p.target_geos.join(", ")}`);
  return parts.filter(Boolean).join("\n\n").trim();
}

// Per-audience candidate kinds + Vectorize indexes (consumed by orchestrator).
export const AUDIENCE_KINDS: Record<Audience, AudienceCandidate["entity_kind"][]> = {
  customer:       ["account", "lead"],
  investor:       ["firm", "lead"],
  partner:        ["company", "firm"],
  hire:           ["lead"],
  design_partner: ["account"],
};
