// Task #5 step 8: relational + voice enrichers.
// mutual / competitive / appreciation / voice.

import type { Env } from "../../../types";
import type { AppreciationSignalKind } from "../../../entities/profile-shapes";
import { type Enricher, type EnricherResult, type StructuredWrite } from "../types";

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

// =========================================================================
// mutualConnectionProfiler — BFS over rel_edges to find common neighbors
// the target shares with any candidate "viewer" entity. We materialize
// the top-N mutuals as appreciation rows with `signalKind=compliment_topic`
// describing the warm-intro path. The actual viewer-specific warm-intro
// listing is computed at synthesis time from the same rel_edges graph
// + the dossier endpoint's `viewer_entity_id` query param.
// =========================================================================
export const mutualConnectionProfiler: Enricher = {
  name: "mutualConnectionProfiler",
  category: "mutual",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const writes: StructuredWrite[] = [];
    let neighbors: Array<{ dst_entity_id: string; kind: string; strength: number; evidence_url: string | null; display: string | null }> = [];
    try {
      const r = await env.DB.prepare(
        `SELECT dst_entity_id, kind, strength, evidence_url,
                (SELECT display_name FROM u_entities WHERE id = dst_entity_id) AS display
           FROM rel_edges
          WHERE src_entity_id = ?
          ORDER BY strength DESC LIMIT 50`,
      ).bind(entityId).all<{ dst_entity_id: string; kind: string; strength: number; evidence_url: string | null; display: string | null }>();
      neighbors = r.results ?? [];
    } catch { /* rel_edges may not exist */ }
    // Note: we surface the top 10 strongest direct connections as
    // "mutual potential" so the dossier always has something to compute
    // warm-intro paths over. The synthesizer (synthesize.ts) materializes
    // viewer-specific 2-hop paths at read time.
    for (const n of neighbors.slice(0, 10)) {
      if (!n.evidence_url) continue;
      const who = n.display ?? n.dst_entity_id;
      writes.push({
        kind: "appreciation",
        input: {
          entityId,
          signalKind: "compliment_topic" as AppreciationSignalKind,
          signalText: `Mutual-connection candidate: ${who} (${n.kind}, strength ${n.strength.toFixed(2)})`,
          sourceUrl: n.evidence_url, confidence: Math.min(1, n.strength),
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// competitiveProfiler — public criticisms, passed-on deals, endorsed-vs-
// avoided brands → "do not pitch" appreciation rows (negative signal).
// =========================================================================
export const competitiveProfiler: Enricher = {
  name: "competitiveProfiler",
  category: "competitive",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await factsByPrefix(env, entityId, "person.criticism");
    const writes: StructuredWrite[] = [];
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const text = (v.text as string) ?? f.value_text ?? "";
      if (!text) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "appreciation",
        input: {
          entityId,
          signalKind: "cause_advocated",
          signalText: `Do not pitch: ${text.slice(0, 200)}`,
          sourceUrl, confidence: 0.7,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// appreciationProfiler — publicly thanked gifts, donations, raved-about
// restaurants → addAppreciationSignal "gift_idea" / "recognition_received".
// =========================================================================
export const appreciationProfiler: Enricher = {
  name: "appreciationProfiler",
  category: "appreciation",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await factsByPrefix(env, entityId, "person.appreciation");
    const writes: StructuredWrite[] = [];
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const text = (v.text as string) ?? f.value_text ?? "";
      if (!text) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      const kind = ((v.signal_kind as AppreciationSignalKind) ?? "gift_idea") as AppreciationSignalKind;
      writes.push({
        kind: "appreciation",
        input: {
          entityId, signalKind: kind, signalText: text.slice(0, 250),
          sourceUrl, confidence: 0.7,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// voiceProfiler — over Task 43 transcripts: speech patterns, frequent
// phrases, opener/closer style → preference rows. No audio synthesis.
// =========================================================================
export const voiceProfiler: Enricher = {
  name: "voiceProfiler",
  category: "voice",
  respectsPrivacy: true, // transcripts can include sensitive content
  estCostUsd: () => 0,
  async run(env, entityId, ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    if (ctx.privacy.respects_privacy) {
      return { writes: [], cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 }, skipped: { reason: "privacy_gate" } };
    }
    const facts = await factsByPrefix(env, entityId, "person.voice");
    const writes: StructuredWrite[] = [];
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const phrase = (v.phrase as string) ?? f.value_text ?? "";
      if (!phrase) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "preference",
        input: {
          entityId, preferenceKey: "voice_pattern",
          valueText: phrase.slice(0, 200),
          sourceUrl, confidence: 0.6,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

export const relationalCategoryEnrichers: Enricher[] = [
  mutualConnectionProfiler, competitiveProfiler, appreciationProfiler, voiceProfiler,
];
