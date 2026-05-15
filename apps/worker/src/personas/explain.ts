// Task #46: AI-generated 2-sentence fit explanations.
//
// Cache key: (persona_id, entity_kind, entity_id, persona.last_modified,
// entity.last_modified). When fit_score < 50 we don't generate (saves
// neurons + the dashboard hides explanations for low matches anyway).

import type { Env } from "../types";
import { aiCacheGet, aiCachePut, sha256Hex } from "../ai/cache";
import { assertBudget } from "../ai/budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";
import type { ScoreComponents, PersonaSpec } from "./score";

export interface ExplainCtx {
  persona: PersonaSpec & { name: string; thesis: string | null; last_modified: string };
  entity: {
    kind: "account" | "buyer";
    id: string;
    name: string;
    last_modified: string;
    facts: Record<string, unknown>;     // domain, industry, employees, top signals, top techs, top buyer
  };
  components: ScoreComponents;
  fit_score: number;
}

export async function explainFit(env: Env, ctx: ExplainCtx): Promise<string | null> {
  if (ctx.fit_score < 50) return null;
  if (!env.AI) return null;

  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const cacheKey = await sha256Hex(`${model}:persona-explain:${ctx.persona.id}:${ctx.entity.kind}:${ctx.entity.id}:${ctx.persona.last_modified}:${ctx.entity.last_modified}`);
  const cached = await aiCacheGet<{ text: string }>(env, cacheKey);
  if (cached) {
    trackAi(env, { purpose: "explanation", model, cacheHit: true });
    return cached.text;
  }

  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return null;
  if (!(await limitAi(env))) return null;

  const factSummary = JSON.stringify(ctx.entity.facts).slice(0, 1500);
  const componentSummary = Object.entries(ctx.components)
    .filter(([k]) => !["weights","reasons"].includes(k))
    .map(([k, v]) => `${k}=${typeof v === "number" ? Math.round(v) : v}`)
    .join(" ");

  const t0 = Date.now();
  let text = "";
  try {
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: "You write 2-sentence sales-fit explanations. Always cite ONE concrete fact (signal, tech, employee count, or buyer title) from the candidate. No hype. No repetition of the score number." },
        { role: "user", content:
          `Persona "${ctx.persona.name}" (fit ${ctx.fit_score}/100, components: ${componentSummary}).\n` +
          `Persona thesis: ${ctx.persona.thesis ?? "—"}\n` +
          `${ctx.entity.kind === "account" ? "Account" : "Buyer"} "${ctx.entity.name}" facts: ${factSummary}\n` +
          `Write exactly 2 sentences explaining why this is a fit.`,
        },
      ],
    })) as { response?: string };
    text = (res?.response ?? "").trim();
    if (text.length > 600) text = text.slice(0, 600);
  } catch (e) {
    console.warn("explainFit failed", (e as Error).message);
    return null;
  }
  trackAi(env, { purpose: "explanation", model, ms: Date.now() - t0 });
  if (text) await aiCachePut(env, cacheKey, { text });
  return text || null;
}
