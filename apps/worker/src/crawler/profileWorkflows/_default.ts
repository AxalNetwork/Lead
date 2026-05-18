// Task #1: generic fallback workflow.
//
// Activated when a page classifies as profile-like but no e_types
// entry matches (or matches without a dedicated module). Instead of
// trusting the single candidate page, this workflow web-searches for
// independent corroborating sources, then runs the standard
// fetch → AI extract → crossRef → persist pipeline across the top
// three result URLs.
//
// The search query is built from the candidate's <title> + domain so
// the result set tends to surface the entity's own profile pages on
// LinkedIn / Crunchbase / Wikipedia / press sites — giving the
// crossRef verifier real cross-source signal even for unknown types.

import type { Env } from "../../types";
import { runStandardWorkflow, hostOf } from "./_shared";
import { search, type SearchHit } from "../../discovery/searx";
import type {
  FactCandidate, PlannedSource, ProfileWorkflow, WorkflowContext,
  WorkflowDef, WorkflowResult, WorkflowRunOpts,
} from "./_types";

const DEFAULT_SCHEMA = {
  type: "object",
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        properties: {
          predicate: { type: "string" },
          value: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["predicate", "value"],
      },
    },
  },
  required: ["facts"],
} as const;

const SYSTEM_PROMPT =
  "Extract structured facts about the primary entity on this page. " +
  "Each fact is a (predicate, value, confidence) triple. Use lowercase " +
  "snake_case predicates (e.g. 'display_name', 'one_liner', 'sector', " +
  "'location_city'). Skip navigation, footers, and unrelated content. " +
  "Reply strict JSON: {facts:[{predicate, value, confidence:0..1}]}.";

function mapDefaultJson(args: { aiJson: unknown; source: { url: string; tag: string } }): FactCandidate[] {
  const j = args.aiJson as { facts?: Array<{ predicate?: string; value?: string; confidence?: number }> };
  if (!Array.isArray(j?.facts)) return [];
  const out: FactCandidate[] = [];
  for (const f of j.facts) {
    const pred = typeof f?.predicate === "string" ? f.predicate.trim().toLowerCase() : "";
    const val = typeof f?.value === "string" ? f.value.trim() : "";
    if (!pred || !val) continue;
    out.push({
      predicate: pred,
      valueText: val,
      sourceUrl: args.source.url,
      sourceTag: args.source.tag,
      confidence: Math.min(0.7, Math.max(0.1, Number(f.confidence ?? 0.5))),
    });
  }
  return out;
}

/** Pull the <title> tag for a search-query seed. */
function titleOf(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return (m?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
}

/**
 * Build a source plan that includes up to 3 independent corroborating
 * URLs from a web search. Excludes hits on the candidate's own host so
 * crossRef sees genuinely distinct buckets.
 */
async function planFromSearch(env: Env, ctx: WorkflowContext): Promise<PlannedSource[]> {
  const candidateHost = hostOf(ctx.candidateUrl);
  const title = titleOf(ctx.candidateHtml);
  const q = title
    ? `"${title}" ${candidateHost}`
    : candidateHost;
  let hits: SearchHit[] = [];
  try {
    hits = await search(env, q, 10);
  } catch {
    return [];
  }
  const sources: PlannedSource[] = [];
  const seenHosts = new Set<string>([candidateHost]);
  for (const h of hits) {
    if (sources.length >= 3) break;
    const host = hostOf(h.url);
    if (!host || seenHosts.has(host)) continue;
    seenHosts.add(host);
    sources.push({ tag: `search:${host}`, url: h.url, optional: true });
  }
  return sources;
}

/**
 * Public workflow. Differs from `makeWorkflow(def)` only in that the
 * `plan` callback is async (it issues a web search). We implement
 * `run()` directly to await the search before delegating to
 * `runStandardWorkflow`.
 */
export const defaultWorkflow: ProfileWorkflow = {
  id: "_default.v1",
  profile_type_id: "_default",
  estimated_cost_per_run: { sources: 4, ai_neurons: 0.4 },
  run: async (env: Env, ctx: WorkflowContext, opts: WorkflowRunOpts = {}): Promise<WorkflowResult> => {
    const dynamicSources = await planFromSearch(env, ctx);
    const def: WorkflowDef = {
      id: "_default.v1",
      profile_type_id: "_default",
      estimated_cost_per_run: { sources: 1 + dynamicSources.length, ai_neurons: 0.1 * (1 + dynamicSources.length) },
      plan: () => dynamicSources,
      extractionSchema: DEFAULT_SCHEMA as unknown as Record<string, unknown>,
      systemPrompt: SYSTEM_PROMPT,
      map: mapDefaultJson,
    };
    return runStandardWorkflow(env, def, ctx, opts);
  },
};
