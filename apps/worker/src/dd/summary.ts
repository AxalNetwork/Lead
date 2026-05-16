// Task #3: AI-generated executive summary for a DD scan.
//
// Single-shot Workers AI call with the top findings + score components.
// Cached by sha256 of the input payload so re-runs on an unchanged
// state are free.

import type { Env } from "../types";
import { aiCacheGet, aiCachePut, sha256Hex } from "../ai/cache";
import { assertBudget } from "../ai/budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";

const AI_TIMEOUT_MS = 20_000;

interface SummaryFinding {
  finding_type: string;
  finding_subtype?: string | null;
  severity: string;
  title: string;
  source_provider: string;
  match_score?: number | null;
}

export interface SummaryInput {
  entity_name: string;
  risk_score: number;
  trust_score: number;
  risk_band: string;
  components: Record<string, number>;
  findings: SummaryFinding[];
}

const SYSTEM = "You are a compliance analyst. Write a concise three-paragraph executive summary of due-diligence findings for the given subject. Paragraph 1: overall risk posture and headline drivers. Paragraph 2: most material findings (cite specific finding categories and counts; never invent details not in the input). Paragraph 3: recommended next steps for a human reviewer. Avoid hedging language. Plain text, no markdown headers.";

export async function generateAiSummary(env: Env, input: SummaryInput): Promise<{ summary: string | null; model: string | null }> {
  if (!env.AI) return { summary: null, model: null };
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const compact = {
    name: input.entity_name,
    risk_score: input.risk_score,
    trust_score: input.trust_score,
    risk_band: input.risk_band,
    components: input.components,
    top_findings: input.findings.slice(0, 12).map((f) => ({
      type: f.finding_type,
      subtype: f.finding_subtype,
      severity: f.severity,
      title: f.title,
      provider: f.source_provider,
      match: f.match_score,
    })),
  };
  const cacheKey = await sha256Hex(`${model}:dd-summary:${JSON.stringify(compact)}`);
  const cached = await aiCacheGet<string>(env, cacheKey);
  if (cached) {
    trackAi(env, { purpose: "bio_summary", model, cacheHit: true });
    return { summary: cached, model };
  }
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return { summary: null, model };
  if (!(await limitAi(env))) return { summary: null, model };
  const t0 = Date.now();
  try {
    const res = await Promise.race<unknown>([
      env.AI.run(model, {
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: `Findings JSON:\n${JSON.stringify(compact)}` },
        ],
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error("ai_timeout")), AI_TIMEOUT_MS)),
    ]);
    const r = res as { response?: string };
    const text = typeof r?.response === "string" ? r.response.trim() : null;
    if (text) await aiCachePut(env, cacheKey, text);
    trackAi(env, { purpose: "bio_summary", model, ms: Date.now() - t0 });
    return { summary: text, model };
  } catch (e) {
    console.warn("generateAiSummary failed", (e as Error).message);
    return { summary: null, model };
  }
}
