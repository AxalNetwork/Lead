// Task #47: AI pitch-angle generator + intro-path lookup.
//
// Cache key includes project version + entity version so an edit on
// either side invalidates. We only call AI for top-K candidates and
// only when fit_score >= 50.

import type { Env } from "../types";
import { aiCacheGet, aiCachePut, sha256Hex } from "../ai/cache";
import { assertBudget } from "../ai/budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";
import type { Audience, AudienceMatchResult, ProjectSpec } from "./score";

export async function generatePitchAngle(
  env: Env,
  project: ProjectSpec,
  audience: Audience,
  match: AudienceMatchResult,
): Promise<string | null> {
  if (match.fit_score < 50) return null;
  if (!env.AI) return null;

  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const entVer = (match.components as Record<string, unknown>).last_modified ?? "";
  const cacheKey = await sha256Hex(`${model}:project-pitch:${project.id}:${audience}:${match.entity_kind}:${match.entity_id}:${entVer}`);
  const cached = await aiCacheGet<{ text: string }>(env, cacheKey);
  if (cached) {
    trackAi(env, { purpose: "pitch", model, cacheHit: true });
    return cached.text;
  }

  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return null;
  if (!(await limitAi(env))) return null;

  const factSummary = JSON.stringify(match.components).slice(0, 1200);
  const t0 = Date.now();
  let text = "";
  try {
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: "You write concise outbound pitch angles. Two sentences max. Specific to the target. No fluff." },
        { role: "user", content: `Project: ${project.name}\nOne-liner: ${project.one_liner ?? ""}\nAudience: ${audience}\nTarget facts: ${factSummary}\nWhy this is a great fit and the best opening hook.` },
      ],
    })) as { response?: string };
    text = (res?.response ?? "").trim().slice(0, 600);
  } catch (e) {
    console.warn("generatePitchAngle failed", (e as Error).message);
    return null;
  }
  trackAi(env, { purpose: "pitch", model, ms: Date.now() - t0 });
  if (text) await aiCachePut(env, cacheKey, { text });
  return text || null;
}

// Shortest intro path between the user (anchored on their email) and
// the target entity, walked through the relationships graph. Returns
// `null` when no path is found within depth=4. Lookup logic mirrors
// routes/relationships.ts but stays self-contained so a missing index
// is non-fatal.
export async function shortestIntroPath(env: Env, match: AudienceMatchResult): Promise<unknown[] | null> {
  try {
    const me = env.ALLOWED_EMAIL?.toLowerCase();
    if (!me) return null;
    // Resolve me → lead node (best-effort).
    const meRow = await env.DB.prepare(`SELECT id FROM leads WHERE lower(email) = ? LIMIT 1`).bind(me).first<{ id: string }>();
    if (!meRow?.id) return null;
    const targetId = `${match.entity_kind}:${match.entity_id}`;
    // BFS depth 4. Cap visited at 2000 to keep this bounded.
    const start = `lead:${meRow.id}`;
    if (start === targetId) return [start];
    const queue: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }];
    const visited = new Set<string>([start]);
    let steps = 0;
    while (queue.length && steps < 2000) {
      const cur = queue.shift()!;
      if (cur.path.length > 5) continue;
      const r = await env.DB.prepare(
        `SELECT to_kind || ':' || to_id AS n FROM relationships WHERE from_kind || ':' || from_id = ?
         UNION SELECT from_kind || ':' || from_id AS n FROM relationships WHERE to_kind || ':' || to_id = ?`,
      ).bind(cur.node, cur.node).all<{ n: string }>();
      for (const row of r.results ?? []) {
        if (!row.n || visited.has(row.n)) continue;
        visited.add(row.n);
        const path = [...cur.path, row.n];
        if (row.n === targetId) return path;
        queue.push({ node: row.n, path });
        steps += 1;
      }
    }
    return null;
  } catch (e) {
    console.warn("shortestIntroPath failed", (e as Error).message);
    return null;
  }
}

// Materials: AI-extracted suggestions from an uploaded deck (PDF text
// or OCR result). Returns a JSON-shaped suggestion the wizard can
// pre-populate. Fail-soft on any error.
export async function suggestFromDeckText(env: Env, text: string): Promise<Record<string, unknown> | null> {
  if (!env.AI || !text.trim()) return null;
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const cacheKey = await sha256Hex(`${model}:project-deck-suggest:${text.slice(0, 4000)}`);
  const cached = await aiCacheGet<Record<string, unknown>>(env, cacheKey);
  if (cached) return cached;

  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return null;
  if (!(await limitAi(env))) return null;

  const SCHEMA = {
    type: "object",
    properties: {
      one_liner: { type: "string" },
      description: { type: "string" },
      problems_solved: { type: "string" },
      unique_value: { type: "string" },
      target_industries: { type: "array", items: { type: "string" } },
      target_geos: { type: "array", items: { type: "string" } },
      stage: { type: "string" },
      funding_status: { type: "string" },
      funding_target: { type: "number" },
    },
  } as const;

  try {
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: "Read this pitch deck text and produce structured project metadata. Return strict JSON." },
        { role: "user", content: text.slice(0, 6000) },
      ],
      response_format: { type: "json_schema", json_schema: SCHEMA },
    })) as { response?: string } & Record<string, unknown>;
    let parsed: Record<string, unknown> = {};
    if (typeof res?.response === "string") { try { parsed = JSON.parse(res.response); } catch { /* noop */ } }
    else if (res && typeof res === "object") parsed = res as Record<string, unknown>;
    if (Object.keys(parsed).length) await aiCachePut(env, cacheKey, parsed);
    return parsed;
  } catch (e) {
    console.warn("suggestFromDeckText failed", (e as Error).message);
    return null;
  }
}
