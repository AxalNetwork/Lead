// Task #5 step 7: sales-context enrichers.
// pain / purchase / schedule / communication.

import type { Env } from "../../../types";
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
         ORDER BY observed_at DESC LIMIT 200`,
    ).bind(entityId, `${prefix}%`).all<FactRow>();
    return r.results ?? [];
  } catch { return []; }
}
function parseJson<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

// =========================================================================
// painPointProfiler — promotes person.pain_point or org.pain_point facts
// (from job postings analysis, raise + use-of-funds, frustrated posts).
// =========================================================================
export const painPointProfiler: Enricher = {
  name: "painPointProfiler",
  category: "pain_point",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await factsByPrefix(env, entityId, "person.pain_point");
    const writes: StructuredWrite[] = [];
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const text = (v.text as string) ?? f.value_text ?? "";
      if (!text) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "goal",
        input: {
          entityId,
          goalKind: "short_term",
          goalText: `Pain point: ${text.slice(0, 400)}`,
          sourceUrl, confidence: 0.6,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// purchaseSignalProfiler — county real-estate, FAA/USCG, whois, corporate
// filings → recent significant purchases. Privacy-gated (a "no press"
// person hasn't waived public-record visibility, but we still respect
// the declared signal — task spec).
// =========================================================================
export const purchaseSignalProfiler: Enricher = {
  name: "purchaseSignalProfiler",
  category: "purchase_signal",
  respectsPrivacy: true,
  estCostUsd: () => 0,
  async run(env, entityId, ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    if (ctx.privacy.respects_privacy) return skipped("privacy_gate", Date.now() - t0);
    const facts = await factsByPrefix(env, entityId, "person.purchase");
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
          entityId, signalKey: "recent_purchase",
          valueText: detail.slice(0, 250),
          valueJson: { detail, frequency: "occasional" },
          sourceUrl, confidence: 0.6,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// scheduleProfiler — post-timing histogram → preferred_meeting_times_json
// + current_timezone, stored as person.preference.schedule.
// Reads fact observed_at timestamps (hour-of-day distribution).
// =========================================================================
export const scheduleProfiler: Enricher = {
  name: "scheduleProfiler",
  category: "schedule",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    let times: Array<{ observed_at: string }> = [];
    try {
      const r = await env.DB.prepare(
        `SELECT observed_at FROM facts WHERE entity_id = ?
            AND datetime(observed_at) >= datetime('now','-90 days')
          ORDER BY observed_at DESC LIMIT 500`,
      ).bind(entityId).all<{ observed_at: string }>();
      times = r.results ?? [];
    } catch { /* ignore */ }
    if (times.length < 5) {
      return { writes: [], cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 }, skipped: { reason: "insufficient_signal" } };
    }
    const hist = new Array<number>(24).fill(0);
    for (const t of times) {
      const ms = Date.parse(t.observed_at);
      if (!Number.isFinite(ms)) continue;
      const h = new Date(ms).getUTCHours();
      hist[h] += 1;
    }
    const total = hist.reduce((a, b) => a + b, 0) || 1;
    const peakHourUTC = hist.indexOf(Math.max(...hist));
    const sourceUrl = `internal://profiler/scheduleProfiler/${entityId}`;
    // Note: scheduleProfiler synthesizes from observed data, so the
    // "source_url" is an internal pointer (allowed: this is an inferred
    // preference, not a public claim about the person).
    const writes: StructuredWrite[] = [{
      kind: "preference",
      input: {
        entityId,
        preferenceKey: "schedule",
        valueJson: {
          value: { peak_hour_utc: peakHourUTC, total_samples: total, hour_histogram_utc: hist },
        },
        sourceUrl,
        confidence: Math.min(0.95, 0.5 + Math.log10(total) * 0.1),
      },
    }];
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// communicationProfiler — response cadence, formality, language →
// preferred_comm_channel + formality_preference. Reads person.comm facts
// or falls back to identity-handle list to pick the most-active channel.
// =========================================================================
export const communicationProfiler: Enricher = {
  name: "communicationProfiler",
  category: "communication",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const writes: StructuredWrite[] = [];
    // Identity-handle counts → most-active channel.
    let handles: Array<{ platform: string }> = [];
    try {
      const r = await env.DB.prepare(
        `SELECT platform FROM identity_handles WHERE entity_id = ? AND is_active = 1`,
      ).bind(entityId).all<{ platform: string }>();
      handles = r.results ?? [];
    } catch { /* osint table may not exist */ }
    const platformCounts = new Map<string, number>();
    for (const h of handles) platformCounts.set(h.platform, (platformCounts.get(h.platform) ?? 0) + 1);
    const ranked = [...platformCounts.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length > 0) {
      writes.push({
        kind: "preference",
        input: {
          entityId, preferenceKey: "comm_channel",
          valueJson: { value: { primary: ranked[0][0], ranked: ranked.map(([p]) => p) } },
          sourceUrl: `internal://profiler/communicationProfiler/${entityId}`,
          confidence: 0.6,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

export const salesContextCategoryEnrichers: Enricher[] = [
  painPointProfiler, purchaseSignalProfiler, scheduleProfiler, communicationProfiler,
];
