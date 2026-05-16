// Task #3: Endorsement mining from news articles.
//
// Detects sentences like "X endorsed Y for Z" and converts them into
// political_donations rows (kind=endorsement-style) and an entity_evidence_quotes
// entry. Conservative — only writes when the model returns a quote
// verbatim from the article body.

import type { Env } from "../types";
import { insertEvidence } from "./repo";

const AI_TIMEOUT_MS = 20_000;
async function runAiWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`ai_timeout:${label}:${ms}ms`)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

interface EndorsementRaw { endorser?: string; endorsed?: string; office?: string; quote?: string }

export async function mineEndorsementsForArticle(env: Env, opts: { newsItemId: string; subjectEntityId: string; subjectName: string; articleText: string }): Promise<number> {
  if (!env.AI || !opts.articleText.trim()) return 0;
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const sys = `Extract political endorsements involving the SUBJECT from the ARTICLE.
Return ONLY a strict JSON array. Each item:
{"endorser":"<person/org>","endorsed":"<candidate/cause>","office":"<office or '' if none>","quote":"<exact sentence from the article supporting the endorsement, ≤240 chars>"}
Rules:
- Only emit endorsements the article ACTUALLY states. Skip rumors.
- The SUBJECT must appear as either endorser or endorsed.
- Max 5 items. If none, return [].`;
  try {
    const res = (await runAiWithTimeout(env.AI.run(model, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `SUBJECT: ${opts.subjectName}\n\nARTICLE:\n${opts.articleText.slice(0, 5000)}` },
      ],
      max_tokens: 400,
      temperature: 0.1,
    }), AI_TIMEOUT_MS, "endorsements")) as { response?: string } | string;
    const out = typeof res === "string" ? res : (res?.response ?? "");
    const m = out.match(/\[[\s\S]*\]/);
    if (!m) return 0;
    const arr = JSON.parse(m[0]) as EndorsementRaw[];
    const valid = arr.filter((e) => e && typeof e.endorser === "string" && typeof e.endorsed === "string" && typeof e.quote === "string").slice(0, 5);
    if (!valid.length) return 0;
    await insertEvidence(env, valid.map((e) => ({
      entity_id: opts.subjectEntityId,
      axis: "endorsement",
      score: null,
      quote: `${e.endorser} → ${e.endorsed}${e.office ? " (" + e.office + ")" : ""}: ${e.quote}`,
      source_kind: "news",
      news_item_id: opts.newsItemId,
    })));
    return valid.length;
  } catch (e) {
    console.warn("mineEndorsements failed", (e as Error).message);
    return 0;
  }
}
