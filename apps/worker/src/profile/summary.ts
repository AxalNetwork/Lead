// Task #3: AI summary of a public persona.
//
// Cached in AI_CACHE R2 keyed on sha256(model + evidence_hash). The
// caller passes an `evidenceHash` it already computed for classification
// so a single corpus produces both: classification + summary, with no
// double-billing on AI when the evidence corpus is unchanged.

import type { Env } from "../types";
import { aiCacheGet, aiCachePut, sha256Hex } from "../ai/cache";
import { assertBudget } from "../ai/budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";

const AI_TIMEOUT_MS = 30_000;

async function runAiWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`ai_timeout:${label}:${ms}ms`)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface SummaryInput {
  entityId: string;
  subject: string;
  evidenceHash: string;
  evidenceText: string;
  primaryType: string | null;
  ideologyConf: number | null;
  isPep: boolean;
  isGovt: boolean;
}

export async function generateProfileSummary(env: Env, input: SummaryInput): Promise<string | null> {
  if (!env.AI || !input.evidenceText.trim()) return null;
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const cacheKey = await sha256Hex(`${model}:profile_summary:${input.evidenceHash}`);
  const cached = await aiCacheGet<string>(env, cacheKey);
  if (cached) { trackAi(env, { purpose: "profile_summary", model, cacheHit: true }); return cached; }

  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return null;
  if (!(await limitAi(env))) return null;

  const sys = `Write a neutral, 4-6 sentence public-persona summary of the SUBJECT based ONLY on the EVIDENCE provided.
Rules:
- Use plain language. No flattery, no editorializing.
- Mention current role(s), notable affiliations, and major policy or business positions if supported.
- If the evidence is sparse, write a shorter summary — do NOT invent facts.
- Do not include the subject's home address, phone, or any personal contact information.
- Do not speculate about ethnicity, sexual orientation, religion, or health unless the evidence makes those self-disclosed.
- Output plain text only — no markdown, no lists.`;

  const userTags: string[] = [];
  if (input.primaryType) userTags.push(`primary_type=${input.primaryType}`);
  if (input.isGovt) userTags.push("currently_serving_in_government");
  if (input.isPep && !input.isGovt) userTags.push("politically_exposed_person");
  if (typeof input.ideologyConf === "number") userTags.push(`ideology_confidence=${input.ideologyConf.toFixed(2)}`);

  try {
    const t0 = Date.now();
    const res = (await runAiWithTimeout(env.AI.run(model, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `SUBJECT: ${input.subject}\nTAGS: ${userTags.join(", ") || "—"}\n\nEVIDENCE:\n${input.evidenceText}` },
      ],
      max_tokens: 320,
      temperature: 0.2,
    }), AI_TIMEOUT_MS, "profile_summary")) as { response?: string } | string;
    trackAi(env, { purpose: "profile_summary", model, ms: Date.now() - t0 });
    const text = typeof res === "string" ? res : (res?.response ?? "");
    const cleaned = (text || "").trim().slice(0, 1200);
    if (cleaned) await aiCachePut(env, cacheKey, cleaned);
    return cleaned || null;
  } catch (e) {
    console.warn("generateProfileSummary failed", (e as Error).message);
    return null;
  }
}
