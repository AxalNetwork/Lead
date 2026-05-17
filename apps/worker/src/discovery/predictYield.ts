// Task #2: yield prediction for a discovered URL.
//
// Heuristic-first (cheap, deterministic), AI-second (only when the
// heuristic is ambiguous AND we have budget). Returns a score in 0..1
// plus a predicted_kind label. Caches AI verdicts in AI_CACHE keyed on
// (host_path_pattern, link_text_hash, method) so repeat URLs are free.

import type { Env } from "../types";
import { canonicalizeUrl } from "./canonical";
import { aiCacheGet, aiCachePut, sha256Hex } from "../ai/cache";
import { assertBudget } from "../ai/budget";
import { limitAi } from "../scraper/rateLimit";

export interface YieldVerdict {
  yield_score: number;       // 0..1, higher = worth crawling
  predicted_kind: string;    // team_page | bio | portfolio | press | aggregator | listing | other
  reasoning: string;
  decided_by: "heuristic" | "ai" | "cache";
}

const HIGH_VALUE_PATHS = [
  /\/(team|people|about|leadership|partners|staff|members|board|advisors?)(\/|$)/i,
  /\/(team|people|about)\/[^/?#]+\/?$/i,                      // /team/jane-doe
  /\/portfolio(\/|$)/i,
  /\/companies?(\/|$)/i,
  /\/(insights?|writings?|essays|blog\/[^/?#]+)(\/|$)/i,
];
const LOW_VALUE_PATHS = [
  /\/(privacy|terms|cookies?|legal|disclosures?|press-kit|sitemap)(\/|$)/i,
  /\/(login|signin|signup|register|cart|checkout|search|tag\/|category\/)/i,
];
const HIGH_VALUE_HOSTS_RE = /\.(vc|fund|capital|ventures)$/i;
const SOCIAL_INTENT_HOSTS_RE = /^(twitter|x)\.(com)$/i;

function heuristic(canonical: string, host: string, text: string, method: string, depth: number): YieldVerdict {
  const reasons: string[] = [];
  let score = 0.35;

  for (const re of HIGH_VALUE_PATHS) if (re.test(canonical)) { score += 0.35; reasons.push("high_value_path"); break; }
  for (const re of LOW_VALUE_PATHS) if (re.test(canonical)) { score -= 0.4; reasons.push("low_value_path"); break; }
  if (HIGH_VALUE_HOSTS_RE.test(host)) { score += 0.1; reasons.push("vc_tld"); }
  if (/\.pdf(\?|$)/i.test(canonical)) { score += 0.05; reasons.push("pdf_doc"); }
  if (SOCIAL_INTENT_HOSTS_RE.test(host) && /\/(intent|share)\b/i.test(canonical)) { score = 0; reasons.push("social_intent"); }
  if (/^(mailto:|tel:|javascript:)/i.test(canonical)) { score = 0; reasons.push("non_http"); }

  // Anchor text signal.
  const lower = (text ?? "").toLowerCase();
  if (/\b(team|people|partners|leadership|biography|cv|founder|principal|managing partner)\b/.test(lower)) { score += 0.15; reasons.push("anchor_text_signal"); }
  if (/\b(read more|learn more|click here|here)\b/.test(lower)) score -= 0.05;

  // Depth decay.
  score -= Math.max(0, depth - 1) * 0.07;

  // Method boost: sister_pages targets bios specifically.
  if (method === "sister_pages") { score += 0.1; reasons.push("sister_method"); }
  if (method === "archive_wayback") score -= 0.05;
  if (method === "jsonld_sameas") { score += 0.05; reasons.push("schema_sameAs"); }

  score = Math.max(0, Math.min(1, score));

  // Kind label.
  let kind = "other";
  if (HIGH_VALUE_PATHS[0].test(canonical) || HIGH_VALUE_PATHS[1].test(canonical)) kind = "team_page";
  else if (/\/portfolio|\/companies?(\/|$)/i.test(canonical)) kind = "portfolio";
  else if (/\/(blog|news|press|insights?|essays)(\/|$)/i.test(canonical)) kind = "press";
  else if (/\.pdf(\?|$)/i.test(canonical)) kind = "pdf";

  return { yield_score: round2(score), predicted_kind: kind, reasoning: reasons.join(",") || "neutral", decided_by: "heuristic" };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export async function predictYield(env: Env, opts: { url: string; method: string; depth: number; link_text?: string | null }): Promise<YieldVerdict> {
  const c = canonicalizeUrl(opts.url);
  if (!c) return { yield_score: 0, predicted_kind: "other", reasoning: "uncanonicalizable", decided_by: "heuristic" };

  const h = heuristic(c.canonical, c.host, opts.link_text ?? "", opts.method, opts.depth);
  // If the heuristic is decisive (very low or very high) skip the AI call.
  if (h.yield_score <= 0.15 || h.yield_score >= 0.75) return h;
  if (!env.AI) return h;

  // Cache key — bucket the path so we don't re-call AI for every URL
  // with a different slug under /team/.
  const pattern = c.canonical.replace(/[A-Za-z0-9_-]{4,}$/, "{slug}");
  const cacheKey = await sha256Hex(`predict_yield:v1:${pattern}:${opts.method}:${(opts.link_text ?? "").slice(0, 60)}`);
  const cached = await aiCacheGet<YieldVerdict>(env, cacheKey);
  if (cached) return { ...cached, decided_by: "cache" };

  const budgetOk = await assertBudget(env, "ai");
  if (!budgetOk.ok) return h;
  if (!(await limitAi(env))) return h;

  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const sys = `You score whether a URL is worth crawling to discover VC-relevant people/firms.
Return STRICT JSON: {"yield_score":<0..1>,"predicted_kind":"team_page|bio|portfolio|press|listing|aggregator|other","reasoning":"<≤120 chars>"}
Score rubric:
- 0.8+ team/people directory pages, individual bios, partner lists, portfolio listings
- 0.5-0.7 substantive blog/essay/press posts, conference programs
- 0.2-0.4 generic news/press, listings of listings
- 0.0-0.2 legal/privacy/login/social-share intent URLs`;
  try {
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `URL: ${c.canonical}\nMETHOD: ${opts.method}\nDEPTH: ${opts.depth}\nLINK_TEXT: ${(opts.link_text ?? "").slice(0, 200)}` },
      ],
      max_tokens: 120,
      temperature: 0,
    })) as { response?: string } | string;
    const txt = typeof res === "string" ? res : (res?.response ?? "");
    const m = txt.match(/\{[\s\S]*\}/);
    if (!m) return h;
    const parsed = JSON.parse(m[0]) as Partial<YieldVerdict>;
    const verdict: YieldVerdict = {
      yield_score: typeof parsed.yield_score === "number" ? Math.max(0, Math.min(1, parsed.yield_score)) : h.yield_score,
      predicted_kind: typeof parsed.predicted_kind === "string" ? parsed.predicted_kind.slice(0, 32) : h.predicted_kind,
      reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning.slice(0, 200) : h.reasoning,
      decided_by: "ai",
    };
    await aiCachePut(env, cacheKey, verdict);
    return verdict;
  } catch (e) {
    console.warn("predictYield ai failed", (e as Error).message);
    return h;
  }
}
