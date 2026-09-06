// Task #5 step 6: media, network, goals, hooks enrichers.
// hookProfiler is the workhorse for the dossier — it converts recent news
// + repeated topics into conversation_hooks rows.

import type { Env } from "../../../types";
import type { GoalKind, ConversationHookKind } from "../../../entities/profile-shapes";
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
// mediaProfiler — podcast appearances (Listen Notes), conference talks
// (YouTube + archive), press quotes (NewsAPI). All gated on key presence.
// =========================================================================
export const mediaProfiler: Enricher = {
  name: "mediaProfiler",
  category: "media",
  respectsPrivacy: false,
  estCostUsd: (env) => (env.NEWS_API_KEY || env.NEWSAPI_KEY ? 0.002 : 0),
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await factsByPrefix(env, entityId, "person.media");
    const writes: StructuredWrite[] = [];
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const topic = (v.topic as string) ?? (v.title as string) ?? f.value_text ?? "";
      if (!topic) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "interest",
        input: {
          entityId, interestCategory: "podcast", interestValue: topic.slice(0, 200),
          sourceUrl, confidence: 0.6,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

// =========================================================================
// networkProfiler — Crunchbase co-investors / X reply-graph / podcast
// co-guests / conference co-speakers. Walks rel_edges where kind in
// (co_invested_with, colleague_of, partner_at). Outputs structured-write
// appreciation rows ("frequent collaborator") so the dossier surfaces a
// closest-associates list.
// =========================================================================
export const networkProfiler: Enricher = {
  name: "networkProfiler",
  category: "network",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const writes: StructuredWrite[] = [];
    let edges: Array<{ dst_entity_id: string; kind: string; strength: number; evidence_url: string | null; display: string | null }> = [];
    try {
      const r = await env.DB.prepare(
        `SELECT e.dst_entity_id, e.kind, e.strength, e.evidence_url,
                (SELECT display_name FROM u_entities WHERE id = e.dst_entity_id) AS display
           FROM rel_edges e
          WHERE e.src_entity_id = ?
            AND e.kind IN ('co_invested_with','colleague_of','partner_at','board_of')
          ORDER BY e.strength DESC LIMIT 20`,
      ).bind(entityId).all<{ dst_entity_id: string; kind: string; strength: number; evidence_url: string | null; display: string | null }>();
      edges = r.results ?? [];
    } catch { /* rel_edges may not exist in lean test setup */ }
    for (const e of edges) {
      if (!e.evidence_url) continue;
      const who = e.display ?? e.dst_entity_id;
      writes.push({
        kind: "appreciation",
        input: {
          entityId,
          signalKind: "compliment_topic",
          signalText: `Frequent collaborator: ${who} (${e.kind})`,
          sourceUrl: e.evidence_url, confidence: Math.min(1, e.strength),
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

const VALID_GOAL_KINDS: ReadonlySet<GoalKind> = new Set([
  "short_term","long_term","hiring","fundraising","investing_thesis","expansion_market",
]);

// =========================================================================
// goalProfiler — LLM over recent posts/transcripts. When AI binding is
// absent or no source facts exist, no-ops. Reads pre-extracted goal facts
// when present.
// =========================================================================
export const goalProfiler: Enricher = {
  name: "goalProfiler",
  category: "goals",
  respectsPrivacy: false,
  estCostUsd: (env) => env.AI ? 0.0005 : 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const facts = await factsByPrefix(env, entityId, "person.goal");
    const writes: StructuredWrite[] = [];
    for (const f of facts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const goalKind = (v.goal_kind as GoalKind) ?? "short_term";
      if (!VALID_GOAL_KINDS.has(goalKind)) continue;
      const goalText = (v.goal_text as string) ?? f.value_text ?? "";
      if (!goalText) continue;
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      writes.push({
        kind: "goal",
        input: {
          entityId, goalKind, goalText: goalText.slice(0, 500),
          targetDate: (v.target_date as string) ?? null,
          sourceUrl, confidence: 0.6,
        },
      });
    }
    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

interface NewsRow { title: string; url: string; published_at: string; summary: string | null }

// =========================================================================
// hookProfiler — top-10 repeated topics in the last 90 days from
// news_articles + person.hook facts → addConversationHook.
// =========================================================================
export const hookProfiler: Enricher = {
  name: "hookProfiler",
  category: "hooks",
  respectsPrivacy: false,
  estCostUsd: () => 0,
  async run(env, entityId, _ctx): Promise<EnricherResult> {
    const t0 = Date.now();
    const writes: StructuredWrite[] = [];
    const seen = new Set<string>();

    // Path 1: recent news articles for this entity (last 90 days).
    let news: NewsRow[] = [];
    try {
      const r = await env.DB.prepare(
        // The articles table is `news_items` and carries no entity_id —
        // the entity link lives in news_entity_mentions. This read named a
        // table that no migration creates and was wrapped in a catch, so it
        // returned nothing and the Conversation Hooks panel stayed empty
        // however much news had been ingested.
        `SELECT ni.title AS title, ni.url AS url, ni.published_at AS published_at,
                ni.summary AS summary
           FROM news_entity_mentions nem
           JOIN news_items ni ON ni.id = nem.news_item_id
          WHERE nem.entity_id = ?
            AND datetime(ni.published_at) >= datetime('now','-90 days')
          ORDER BY ni.published_at DESC LIMIT 25`,
      ).bind(entityId).all<NewsRow>();
      news = r.results ?? [];
    } catch { /* news tables may be absent in a lean test setup */ }

    for (const n of news) {
      const text = (n.title || "").slice(0, 250);
      if (!text || !n.url) continue;
      const key = text.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      writes.push({
        kind: "hook",
        input: {
          entityId,
          hookKind: "recent_news",
          hookText: text,
          sourceUrl: n.url, confidence: 0.7,
        },
      });
    }

    // Path 2: facts pre-extracted as person.hook.* (e.g. by the agent).
    const hookFacts = await factsByPrefix(env, entityId, "person.hook");
    for (const f of hookFacts) {
      const v = parseJson<Record<string, unknown>>(f.value_json) ?? {};
      const hookText = (v.hook_text as string) ?? f.value_text ?? "";
      if (!hookText) continue;
      const key = hookText.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const sourceUrl = f.evidence_url || (v.source_url as string) || "";
      if (!sourceUrl) continue;
      const hk = (v.hook_kind as ConversationHookKind) ?? "recent_post";
      writes.push({
        kind: "hook",
        input: {
          entityId, hookKind: hk, hookText: hookText.slice(0, 250),
          relatedEntityId: (v.related_entity_id as string) ?? null,
          sourceUrl, confidence: 0.7,
        },
      });
    }

    return { writes, cost: { neurons: 0, fetches: 0, bytes: 0, wall_ms: Date.now() - t0, est_usd: 0 } };
  },
};

export const mediaCategoryEnrichers: Enricher[] = [mediaProfiler, networkProfiler, goalProfiler, hookProfiler];
