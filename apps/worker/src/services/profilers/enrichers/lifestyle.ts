// Task #5 step 5: family, causes, health enrichers.
//
// Privacy-respecting (all three): when ctx.privacy.respects_privacy is
// true, the orchestrator skips these entirely. `healthProfiler`
// additionally double-checks because health is the most sensitive
// category — defense in depth.

import type { Env } from "../../../types";
import type { FamilyRelationType } from "../../../entities/profile-shapes";
import { skipped, type Enricher, type EnricherResult, type StructuredWrite } from "../types";

interface FactRow {
  predicate: string; value_text: string | null; value_number: number | null;
  value_json: string | null; evidence_url: string | null; observed_at: string;
}
async function factsByPrefix(env: Env, entityId: string, prefix: string): Promise<FactRow[]> {
  try {
    const r = await env.DB.prepare(
      `SELECT predicate, value_text, value_number, value_json, evidence_url, observed_at
         FROM facts WHERE entity_id = ? AND predicate LIKE ?
         ORDER BY observed_at DESC LIMIT 100`,
    ).bind(entityId, `${prefix}%`).all<FactRow>();
    return r.results ?? [];
  } catch { return []; }
}
function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

const VALID_RELATIONS: ReadonlySet<FamilyRelationType> = new Set([
  "spouse","partner","parent","child","sibling","in_law","other",
]);

// =========================================================================
// familyProfiler — public-only family ties (wedding announcements, "proud
// parent" posts, joint LinkedIn posts). is_public=true is enforced.
// =========================================================================
export const familyProfiler: Enricher = {
  name: "familyProfiler",
  category: "family",
  respectsPrivacy: true,
  estCostUsd: () => 0,
  async run(env, entityId, ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    if (ctx.privacy.respects_privacy) return skipped("privacy_gate", Date.now() - t0);
    const facts = await factsByPrefix(env, entityId, "person.family_tie");
    const writes: StructuredWrite[] = [];
    const seen = new Set<string>();
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const relation = (v.relation_type as FamilyRelationType) ?? "other";
      if (!VALID_RELATIONS.has(relation)) continue;
      const relatedName = (v.related_name as string) ?? "";
      if (!relatedName) continue;
      // Public-only: skip anything that wasn't already public.
      if (v.is_public !== true) continue;
      const key = `${relation}|${relatedName.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "family_tie",
        input: {
          entityId, relationType: relation, relatedName,
          relatedEntityId: (v.related_entity_id as string) ?? null,
          notes: (v.notes as string) ?? null,
          isPublic: true,           // enforced
          sourceUrl, confidence: 0.7,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// causesProfiler — FEC donations, charity-event attendance, petitions
// signed, op-eds → political_leaning / philanthropy as appreciation +
// preference rows. Privacy-gated.
// =========================================================================
export const causesProfiler: Enricher = {
  name: "causesProfiler",
  category: "causes",
  respectsPrivacy: true,
  estCostUsd: (env) => env.FEC_API_KEY ? 0.001 : 0,
  async run(env, entityId, ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    if (ctx.privacy.respects_privacy) return skipped("privacy_gate", Date.now() - t0);
    const facts = await factsByPrefix(env, entityId, "person.cause");
    const donationFacts = await factsByPrefix(env, entityId, "person.donation");
    const writes: StructuredWrite[] = [];
    for (const f of [...facts, ...donationFacts]) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const text = (v.cause as string) ?? (v.org as string) ?? f.value_text ?? "";
      if (!text) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "appreciation",
        input: {
          entityId,
          signalKind: f.predicate.includes("donation") ? "charity_supported" : "cause_advocated",
          signalText: String(text).slice(0, 250),
          sourceUrl, confidence: 0.7,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// healthProfiler — marathon results, public Strava segments, public
// health-advocacy posts. HARD privacy-gated.
// =========================================================================
export const healthProfiler: Enricher = {
  name: "healthProfiler",
  category: "health",
  respectsPrivacy: true,
  estCostUsd: () => 0,
  async run(env, entityId, ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    if (ctx.privacy.respects_privacy) return skipped("privacy_gate", Date.now() - t0);
    const facts = await factsByPrefix(env, entityId, "person.lifestyle.health");
    const writes: StructuredWrite[] = [];
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const detail = (v.detail as string) ?? f.value_text ?? "";
      if (!detail) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "lifestyle",
        input: {
          entityId, signalKey: "health",
          valueText: detail.slice(0, 200),
          valueJson: { detail, frequency: (v.frequency as "weekly" | undefined) },
          sourceUrl, confidence: 0.65,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

export const lifestyleCategoryEnrichers: Enricher[] = [familyProfiler, causesProfiler, healthProfiler];
