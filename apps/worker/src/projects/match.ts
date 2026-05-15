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
  // 1) Persona-derived candidates. Load persona-fit maps for every
  // entity kind this audience actually consumes so persona signal is
  // not silently zeroed for investor/partner/hire.
  const personaIds = spec.persona_ids[audience] ?? [];
  const personaMaps: Partial<Record<AudienceCandidate["entity_kind"], Map<string, number>>> = {};
  for (const kind of AUDIENCE_KINDS[audience]) {
    personaMaps[kind] = await loadPersonaFitMap(env, personaIds, kind);
  }

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
  for (const [kind, m] of Object.entries(personaMaps)) {
    if (!m) continue;
    for (const [id, s] of m) { const c = ensure(kind as AudienceCandidate["entity_kind"], id); if (c) c.persona_score = s; }
  }
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

  // Two-phase recompute per audience:
  //   Phase 1 — score everything, bulk-upsert ranked rows immediately
  //             with empty pitch/intro so the workspace becomes visible
  //             within seconds (well under the 60s SLA).
  //   Phase 2 — enrich top-K rows (pitch + intro) in bounded-parallel
  //             batches and patch each row in place. Phase 2 runs
  //             after persist so a slow AI provider can never delay
  //             results from appearing.
  for (const audience of enabled) {
    const ranked = await rankAudience(env, spec, audience, vector);
    const initial: Array<Parameters<typeof bulkUpsertMatches>[4][number]> = [];
    const keepKeys: Array<{ entity_kind: string; entity_id: string }> = [];
    for (let i = 0; i < ranked.length; i += 1) {
      const r = ranked[i];
      const components = { ...r.components, explanation: null } as Record<string, unknown>;
      initial.push({
        entity_kind: r.entity_kind, entity_id: r.entity_id,
        rank: i + 1, fit_score: r.fit_score,
        persona_score: r.persona_score, semantic_score: r.semantic_score, overlay_score: r.overlay_score,
        components, pitch_angle: null, intro_path: null,
        entity_modified_at: (r.components as Record<string, unknown>).last_modified as string | null,
      });
      keepKeys.push({ entity_kind: r.entity_kind, entity_id: r.entity_id });
    }
    await bulkUpsertMatches(env, projectId, audience, row.last_modified, initial);
    await demoteStaleNewMatches(env, projectId, audience, keepKeys);
    counts[audience] = initial.length;
    out.push({ audience, count: initial.length });

    // Phase 2 — bounded parallel enrichment for top-K. AI failures and
    // intro-path errors are non-fatal: we keep the persisted ranked row.
    const enrichTargets = ranked.slice(0, PITCH_TOP);
    const CONCURRENCY = 8;
    let cursor = 0;
    const workers = Array.from({ length: Math.min(CONCURRENCY, enrichTargets.length) }, async () => {
      while (true) {
        const i = cursor; cursor += 1;
        if (i >= enrichTargets.length) return;
        const r = enrichTargets[i];
        const [pe, intro] = await Promise.all([
          generatePitchAndExplanation(env, spec, audience, r, row.last_modified).catch(() => null),
          shortestIntroPath(env, r).catch(() => null),
        ]);
        const components = { ...r.components, explanation: pe?.explanation ?? null } as Record<string, unknown>;
        try {
          await env.DB.prepare(
            `UPDATE project_matches SET pitch_angle = ?, intro_path_json = ?, components_json = ?
               WHERE project_id = ? AND audience = ? AND entity_kind = ? AND entity_id = ?`,
          ).bind(
            pe?.pitch ?? null, intro ? JSON.stringify(intro) : null, JSON.stringify(components),
            projectId, audience, r.entity_kind, r.entity_id,
          ).run();
        } catch (e) { console.warn("enrichment update failed", (e as Error).message); }
      }
    });
    await Promise.all(workers);
  }

  await setMatchCounts(env, projectId, counts);
  trackAi(env, { purpose: "project_match", model: "match" });
  return { ok: true, audiences: out };
}
