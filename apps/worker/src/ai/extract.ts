// AI-powered extraction (Task #25 step 2).
//
// Strategy: deterministic strategies in `firmcrawl/personExtract.ts` run
// first (cheap). Misses get routed through Workers AI with a strict JSON
// schema response, chunked at ~6KB. Every call is cached by
// sha256(model+prompt+chunk) in the AI_CACHE R2 bucket (30-day TTL via
// bucket lifecycle policy). Verification pass drops <0.6 confidence.
//
// Hooked into pipeline.ts firm_team_crawl path opportunistically: if `AI`
// binding is present and deterministic strategies returned <3 people on a
// non-trivial page, we run the AI pass and union by nameKey.

import type { Env } from "../types";
import { aiCacheGet, aiCachePut, sha256Hex } from "./cache";
import { assertBudget } from "./budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";

export interface AiExtractedPerson {
  name: string;
  role?: string | null;
  email?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  bio?: string | null;
  confidence: number;
}

const PERSON_SCHEMA = {
  type: "object",
  properties: {
    people: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          role: { type: "string" },
          email: { type: "string" },
          linkedin: { type: "string" },
          twitter: { type: "string" },
          bio: { type: "string" },
          confidence: { type: "number" },
        },
        required: ["name", "confidence"],
      },
    },
  },
  required: ["people"],
} as const;

const CHUNK_BYTES = 6000;
const MIN_CONFIDENCE = 0.6;

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export async function aiExtractPeople(env: Env, html: string, jobId?: string): Promise<AiExtractedPerson[]> {
  if (!env.AI) return [];
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return [];
  if (!(await limitAi(env))) return [];

  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const text = stripHtml(html);
  const chunks = chunk(text, CHUNK_BYTES).slice(0, 4); // hard ceiling per page
  const all: AiExtractedPerson[] = [];

  for (const c of chunks) {
    const cacheKey = await sha256Hex(`${model}:people:${c}`);
    const cached = await aiCacheGet<AiExtractedPerson[]>(env, cacheKey);
    if (cached) {
      trackAi(env, { purpose: "extraction", model, cacheHit: true, jobId });
      all.push(...cached);
      continue;
    }
    const t0 = Date.now();
    let people: AiExtractedPerson[] = [];
    try {
      const res = (await env.AI.run(model, {
        messages: [
          { role: "system", content: "Extract investors/partners as JSON. Skip non-people. Return strict JSON." },
          { role: "user", content: `Extract people from this team-page text. ${c}` },
        ],
        response_format: { type: "json_schema", json_schema: PERSON_SCHEMA },
      })) as { response?: string; people?: AiExtractedPerson[] };
      const parsed = parsePeopleResponse(res);
      people = parsed.filter((p) => (p.confidence ?? 0) >= MIN_CONFIDENCE);
    } catch (e) {
      console.warn("aiExtractPeople failed", (e as Error).message);
    }
    trackAi(env, { purpose: "extraction", model, ms: Date.now() - t0, neurons: estimateNeurons(c.length), jobId });
    await aiCachePut(env, cacheKey, people);
    all.push(...people);
  }
  return dedupePeopleByName(all);
}

function parsePeopleResponse(res: unknown): AiExtractedPerson[] {
  const r = res as { response?: string; people?: unknown };
  if (Array.isArray(r?.people)) return (r.people as AiExtractedPerson[]).filter((p) => p && typeof p.name === "string");
  if (typeof r?.response === "string") {
    try {
      const j = JSON.parse(r.response) as { people?: AiExtractedPerson[] };
      if (Array.isArray(j?.people)) return j.people.filter((p) => p && typeof p.name === "string");
    } catch { /* fall through */ }
  }
  return [];
}

function dedupePeopleByName(arr: AiExtractedPerson[]): AiExtractedPerson[] {
  const map = new Map<string, AiExtractedPerson>();
  for (const p of arr) {
    const key = p.name.trim().toLowerCase();
    if (!key) continue;
    const cur = map.get(key);
    if (!cur || (p.confidence ?? 0) > (cur.confidence ?? 0)) map.set(key, p);
  }
  return [...map.values()];
}

// Rough neurons estimate: tokens ≈ chars/4, llama-3.1-8b ~ 0.011 neurons/token.
function estimateNeurons(chars: number): number {
  const tokens = Math.ceil(chars / 4);
  return Math.round(tokens * 0.011 * 1000) / 1000;
}

export async function aiEmbed(env: Env, text: string): Promise<number[] | null> {
  if (!env.AI) return null;
  const model = env.AI_EMBED_MODEL ?? "@cf/baai/bge-base-en-v1.5";
  const cacheKey = await sha256Hex(`${model}:embed:${text}`);
  const cached = await aiCacheGet<number[]>(env, cacheKey);
  if (cached) {
    trackAi(env, { purpose: "embedding", model, cacheHit: true });
    return cached;
  }
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return null;
  if (!(await limitAi(env))) return null;
  const t0 = Date.now();
  try {
    const res = (await env.AI.run(model, { text: [text] })) as { data?: number[][] };
    const vec = Array.isArray(res?.data?.[0]) ? res.data![0] : null;
    if (!vec) return null;
    trackAi(env, { purpose: "embedding", model, ms: Date.now() - t0, neurons: estimateNeurons(text.length) });
    await aiCachePut(env, cacheKey, vec);
    return vec;
  } catch (e) {
    console.warn("aiEmbed failed", (e as Error).message);
    return null;
  }
}

export async function aiArbitrate(env: Env, candidateA: string, candidateB: string): Promise<{ match: "yes" | "no" | "maybe"; confidence: number }> {
  if (!env.AI) return { match: "maybe", confidence: 0 };
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const cacheKey = await sha256Hex(`${model}:arb:${candidateA}|${candidateB}`);
  const cached = await aiCacheGet<{ match: "yes" | "no" | "maybe"; confidence: number }>(env, cacheKey);
  if (cached) {
    trackAi(env, { purpose: "arbitration", model, cacheHit: true });
    return cached;
  }
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return { match: "maybe", confidence: 0 };
  if (!(await limitAi(env))) return { match: "maybe", confidence: 0 };
  const t0 = Date.now();
  try {
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: "Decide if two profiles describe the same person. Reply JSON: {match: yes|no|maybe, confidence: 0..1}." },
        { role: "user", content: `A: ${candidateA}\nB: ${candidateB}` },
      ],
      response_format: { type: "json_object" },
    })) as { response?: string };
    const out = parseArbResponse(res);
    trackAi(env, { purpose: "arbitration", model, ms: Date.now() - t0, neurons: estimateNeurons(candidateA.length + candidateB.length) });
    await aiCachePut(env, cacheKey, out);
    return out;
  } catch (e) {
    console.warn("aiArbitrate failed", (e as Error).message);
    return { match: "maybe", confidence: 0 };
  }
}

function parseArbResponse(res: { response?: string }): { match: "yes" | "no" | "maybe"; confidence: number } {
  if (typeof res?.response === "string") {
    try {
      const j = JSON.parse(res.response) as { match?: string; confidence?: number };
      const match = j.match === "yes" || j.match === "no" ? j.match : "maybe";
      return { match, confidence: Math.max(0, Math.min(1, Number(j.confidence ?? 0))) };
    } catch { /* fall through */ }
  }
  return { match: "maybe", confidence: 0 };
}
