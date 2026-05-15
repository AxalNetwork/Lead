// Task #47: orchestration — combines persona-fit + semantic + overlay
// for every audience on a project, then upserts project_matches and
// updates the project counters.

import type { Env } from "../types";
import {
  getProject, rowToSpec, setMatchCounts, demoteStaleNewMatches,
  loadPersonaFitMap, loadAccountFactsBulk, loadFirmFactsBulk,
  loadCompanyFactsBulk, loadLeadFactsBulk, bulkUpsertMatches,
} from "./repo";
import { embedProject, semanticCandidatesForAudience, type SemanticHit } from "./embed";
import { AUDIENCES, AUDIENCE_KINDS, scoreCandidate, type Audience, type AudienceCandidate, type AudienceMatchResult, type ProjectSpec } from "./score";
import { generatePitchAndExplanation, shortestIntroPath } from "./pitch";
import { trackAi } from "../analytics/events";

const TOP_N_PER_AUDIENCE = 200;
const PITCH_TOP = 50;

async function loadFactsByKind(env: Env, kind: AudienceCandidate["entity_kind"], ids: string[], spec: ProjectSpec): Promise<Map<string, Record<string, unknown>>> {
  switch (kind) {
    case "account": return loadAccountFactsBulk(env, ids);
    case "firm":    return loadFirmFactsBulk(env, ids);
    case "company": return loadCompanyFactsBulk(env, ids, { target_industries: spec.target_industries });
    case "lead":    return loadLeadFactsBulk(env, ids, { target_industries: spec.target_industries });
    case "buyer":   return new Map();
  }
}

async function rankAudience(
  env: Env,
  spec: ProjectSpec,
  audience: Audience,
  projectVector: number[] | null,
): Promise<AudienceMatchResult[]> {
  // 1) Persona-derived candidates (only meaningful for account/buyer kinds).
  const personaIds = spec.persona_ids[audience] ?? [];
  const accountFitMap = await loadPersonaFitMap(env, personaIds, "account");
  // We track buyer-fit independently; today only the customer audience
  // pulls buyers in via persona_matches.
  const buyerFitMap = audience === "customer" ? await loadPersonaFitMap(env, personaIds, "buyer") : new Map<string, number>();

  // 2) Semantic candidates from this audience's vector indexes.
  const semHits: SemanticHit[] = projectVector
    ? await semanticCandidatesForAudience(env, audience, projectVector, TOP_N_PER_AUDIENCE)
    : [];
  const semByKey = new Map<string, number>();
  for (const h of semHits) semByKey.set(`${h.entity_kind}:${h.entity_id}`, h.cosine);

  // 3) Build candidate set: union of persona-derived + semantic.
  const candidates = new Map<string, AudienceCandidate>();
  const allowedKinds = new Set<string>(AUDIENCE_KINDS[audience]);
  const ensure = (kind: AudienceCandidate["entity_kind"], id: string) => {
    if (!allowedKinds.has(kind)) return;
    const k = `${kind}:${id}`;
    if (!candidates.has(k)) {
      candidates.set(k, {
        entity_kind: kind, entity_id: id,
        persona_score: null, semantic_cosine: null, facts: {},
      });
    }
    return candidates.get(k)!;
  };
  if (allowedKinds.has("account")) for (const [id, s] of accountFitMap) { const c = ensure("account", id); if (c) c.persona_score = s; }
  if (allowedKinds.has("buyer"))   for (const [id, s] of buyerFitMap)   { const c = ensure("buyer", id);   if (c) c.persona_score = s; }
  for (const h of semHits) { const c = ensure(h.entity_kind, h.entity_id); if (c) c.semantic_cosine = h.cosine; }

  // 4) Bulk-load facts per kind.
  const byKind = new Map<string, string[]>();
  for (const c of candidates.values()) {
    const arr = byKind.get(c.entity_kind) ?? [];
    arr.push(c.entity_id);
    byKind.set(c.entity_kind, arr);
  }
  for (const [kind, ids] of byKind) {
    const facts = await loadFactsByKind(env, kind as AudienceCandidate["entity_kind"], ids, spec);
    for (const id of ids) {
      const k = `${kind}:${id}`;
      const c = candidates.get(k);
      const f = facts.get(id);
      if (c && f) c.facts = f;
    }
    // Drop candidates we couldn't load facts for (entity may have been deleted).
    for (const id of ids) {
      const k = `${kind}:${id}`;
      const c = candidates.get(k);
      if (c && !facts.has(id) && (c.semantic_cosine == null && (c.persona_score ?? 0) === 0)) candidates.delete(k);
    }
  }

  // 5) Score + sort.
  const scored: AudienceMatchResult[] = [];
  for (const c of candidates.values()) {
    if (!c.facts || !Object.keys(c.facts).length) continue;
    const r = scoreCandidate(audience, spec, c);
    if (r.fit_score > 0) scored.push(r);
  }
  scored.sort((a, b) => b.fit_score - a.fit_score);
  return scored.slice(0, TOP_N_PER_AUDIENCE);
}

export interface MatchAudienceOutput {
  audience: Audience;
  count: number;
}

export async function matchProject(env: Env, projectId: string): Promise<{ ok: true; audiences: MatchAudienceOutput[] }> {
  const row = await getProject(env, projectId);
  if (!row) throw new Error(`project_not_found:${projectId}`);
  const spec = rowToSpec(row);

  // Re-embed (cheap if cached). Persist meta only when text changed.
  const { vector } = await embedProject(env, spec);

  const enabled = AUDIENCES.filter((a) => spec.audiences[a] !== false);
  const counts: Record<string, number> = {};
  const out: MatchAudienceOutput[] = [];

  for (const audience of enabled) {
    const ranked = await rankAudience(env, spec, audience, vector);
    // Generate pitch angles for top-K only.
    const pitchTop = ranked.slice(0, PITCH_TOP);
    const introTop = pitchTop;
    const enriched: Array<Parameters<typeof bulkUpsertMatches>[4][number]> = [];
    const keepKeys: Array<{ entity_kind: string; entity_id: string }> = [];
    for (let i = 0; i < ranked.length; i += 1) {
      const r = ranked[i];
      let pitch: string | null = null;
      let explanation: string | null = null;
      let intro: unknown[] | null = null;
      if (i < pitchTop.length) {
        const pe = await generatePitchAndExplanation(env, spec, audience, r, row.last_modified).catch(() => null);
        if (pe) { pitch = pe.pitch; explanation = pe.explanation; }
      }
      if (i < introTop.length) {
        intro = await shortestIntroPath(env, r).catch(() => null);
      }
      // Fold explanation into components_json so the API response carries
      // it without a schema migration.
      const components = { ...r.components, explanation } as Record<string, unknown>;
      enriched.push({
        entity_kind: r.entity_kind, entity_id: r.entity_id,
        rank: i + 1, fit_score: r.fit_score,
        persona_score: r.persona_score, semantic_score: r.semantic_score, overlay_score: r.overlay_score,
        components, pitch_angle: pitch, intro_path: intro,
        entity_modified_at: (r.components as Record<string, unknown>).last_modified as string | null,
      });
      keepKeys.push({ entity_kind: r.entity_kind, entity_id: r.entity_id });
    }
    // True upsert — preserves status/notes via ON CONFLICT in
    // bulkUpsertMatches. Then demote rank=0 for stale rows whose status
    // is still "new" (untouched by user) so the workspace doesn't show
    // them in the top list while keeping shortlisted/contacted history.
    await bulkUpsertMatches(env, projectId, audience, row.last_modified, enriched);
    await demoteStaleNewMatches(env, projectId, audience, keepKeys);
    counts[audience] = enriched.length;
    out.push({ audience, count: enriched.length });
  }

  await setMatchCounts(env, projectId, counts);
  trackAi(env, { purpose: "project_match", model: "match" });
  return { ok: true, audiences: out };
}
