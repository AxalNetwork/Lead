// Task #2: Per-article enrichment.
//
// For each persisted news_item we:
//   1. Fetch + sanitize the body (strip script/style/nav, keep text).
//   2. Cap body to ~32KB, archive full HTML in RAW_HTML (key on news_items.body_r2_key).
//   3. Run Workers AI NER on the title + first 4KB of body → [{type, name, quote}].
//   4. Resolve each NER hit against u_entities via Vectorize + name fallback.
//   5. Insert news_entity_mentions for confidence ≥ 0.75.
//   6. Compute is_subject = mention in title || first paragraph.
//   7. sentiment_about_entity per mention via Workers AI on the surrounding quote.
//   8. Summarize body to 1 paragraph → news_items.summary.

import type { Env } from "../types";

const UA = "AIDataSignal/1.0 (+https://aidatasignal.com)";
const MAX_BODY_BYTES = 32 * 1024;
const NER_INPUT_BUDGET = 4096;
const MENTION_CONFIDENCE_MIN = 0.75;

export interface NewsItemRow {
  id: string;
  url: string;
  title: string | null;
  host: string;
  language: string | null;
}

export interface NerHit {
  type: "person" | "org" | "place" | "other";
  name: string;
  context_quote: string;
}

export interface MentionResolved {
  entity_id: string;
  name: string;
  confidence: number;
  is_subject: 0 | 1;
  context_quote: string;
  sentiment: number | null;
  mention_count: number;
}

// ---------------- Body fetch + sanitization ----------------

export async function fetchAndSanitize(url: string): Promise<{ body: string; raw: string } | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" }, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) return null;
    const raw = await res.text();
    const body = sanitizeHtml(raw).slice(0, MAX_BODY_BYTES);
    return { body, raw: raw.slice(0, 1024 * 1024) };
  } catch { return null; } finally { clearTimeout(t); }
}

export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Archive raw HTML into RAW_HTML R2 bucket. Returns the key, or null on failure.
export async function archiveRawHtml(env: Env, host: string, raw: string): Promise<string | null> {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const id = crypto.randomUUID();
    const key = `news/${day}/${host}/${id}.html`;
    await env.RAW_HTML.put(key, raw, { httpMetadata: { contentType: "text/html" } });
    return key;
  } catch { return null; }
}

// ---------------- AI: NER ----------------

const NER_PROMPT = `You are an entity tagger. Read the article excerpt and return a strict JSON array of named entities of type "person" or "org" only.
Each item: {"type":"person"|"org","name":"...","context_quote":"the sentence containing the entity, max 200 chars"}.
Skip pronouns, generic terms, and anything that isn't a real-world person/organization. Output JSON ONLY — no prose.`;

export async function runNer(env: Env, text: string): Promise<NerHit[]> {
  if (!env.AI || !text.trim()) return heuristicNer(text);
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 20000);
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: NER_PROMPT },
        { role: "user", content: text.slice(0, NER_INPUT_BUDGET) },
      ],
      max_tokens: 512,
      temperature: 0.1,
    })) as { response?: string } | string;
    clearTimeout(t);
    const out = typeof res === "string" ? res : res?.response ?? "";
    return parseNerOutput(out);
  } catch {
    return heuristicNer(text);
  }
}

function parseNerOutput(s: string): NerHit[] {
  const m = s.match(/\[[\s\S]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as Array<{ type?: string; name?: string; context_quote?: string }>;
    return arr.filter((x) => x && (x.type === "person" || x.type === "org") && typeof x.name === "string" && x.name.length >= 2 && x.name.length <= 120)
      .slice(0, 50)
      .map((x) => ({ type: x.type as NerHit["type"], name: x.name!.trim(), context_quote: (x.context_quote ?? "").slice(0, 300) }));
  } catch { return []; }
}

// Fallback when AI is unavailable: extract capitalized n-grams (very crude).
function heuristicNer(text: string): NerHit[] {
  const out: NerHit[] = [];
  const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
  const seen = new Set<string>();
  for (const m of text.matchAll(re)) {
    const name = m[1];
    if (seen.has(name) || name.length > 60) continue;
    seen.add(name);
    const ctx = text.slice(Math.max(0, (m.index ?? 0) - 80), (m.index ?? 0) + 160);
    out.push({ type: name.split(" ").length === 1 ? "org" : "person", name, context_quote: ctx });
    if (out.length >= 30) break;
  }
  return out;
}

// ---------------- AI: sentiment ----------------

export async function sentimentOf(env: Env, text: string): Promise<number | null> {
  if (!env.AI || !text.trim()) return null;
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  try {
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: 'You output ONLY a single number between -1.0 (very negative) and 1.0 (very positive) reflecting sentiment toward the subject. No prose.' },
        { role: "user", content: text.slice(0, 1200) },
      ],
      max_tokens: 8,
      temperature: 0,
    })) as { response?: string } | string;
    const out = typeof res === "string" ? res : res?.response ?? "";
    const m = out.match(/-?\d+(\.\d+)?/);
    if (!m) return null;
    const n = Number(m[0]);
    return Number.isFinite(n) ? Math.max(-1, Math.min(1, n)) : null;
  } catch { return null; }
}

// ---------------- AI: summary ----------------

export async function summarizeArticle(env: Env, text: string): Promise<string | null> {
  if (!env.AI || !text.trim()) return null;
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  try {
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: "Summarize the article in 1 short paragraph (≤ 60 words). Neutral tone. No editorial. No first person." },
        { role: "user", content: text.slice(0, 6000) },
      ],
      max_tokens: 120,
      temperature: 0.2,
    })) as { response?: string } | string;
    const out = typeof res === "string" ? res : res?.response ?? "";
    return out.trim().slice(0, 500);
  } catch { return null; }
}

// ---------------- Entity resolution ----------------

// Resolve a NER name to a u_entities row. Strategy:
//   1. Exact (case-insensitive) display_name match.
//   2. Substring match if display_name is a prefix of the NER name.
//   3. Vectorize lookup by embedding the name (when VEC_LEADS/FIRMS exist).
// Returns null when no candidate clears MENTION_CONFIDENCE_MIN.
export async function resolveEntity(env: Env, hit: NerHit): Promise<{ entity_id: string; confidence: number } | null> {
  const name = hit.name.trim();
  if (!name) return null;
  // Exact match (case-insensitive). LIMIT 1 — duplicates resolved by merge later.
  const exact = await env.DB.prepare(
    `SELECT id FROM u_entities WHERE lower(display_name) = lower(?) AND status='active' LIMIT 1`,
  ).bind(name).first<{ id: string }>();
  if (exact?.id) return { entity_id: exact.id, confidence: 0.95 };

  // Prefix / substring match. We don't FTS here — small index suffices.
  const fuzzy = await env.DB.prepare(
    `SELECT id, display_name FROM u_entities
      WHERE status='active' AND display_name IS NOT NULL
        AND (display_name LIKE ? OR ? LIKE display_name || '%')
      LIMIT 5`,
  ).bind(`${name}%`, name).all<{ id: string; display_name: string }>();
  for (const row of fuzzy.results ?? []) {
    const a = row.display_name.toLowerCase(); const b = name.toLowerCase();
    if (a === b) return { entity_id: row.id, confidence: 0.95 };
    if (a.startsWith(b) || b.startsWith(a)) return { entity_id: row.id, confidence: 0.8 };
  }
  return null;
}

// Run the full enrichment pass on a single persisted news_item. The body
// must already be fetched + sanitized (passed in to avoid double-fetch).
export async function enrichArticle(env: Env, item: NewsItemRow, body: string): Promise<{ mentions: MentionResolved[]; summary: string | null; sentiment: number | null }> {
  const titlePlusBody = `${item.title ?? ""}\n\n${body}`;
  const titleLower = (item.title ?? "").toLowerCase();
  const firstPara = body.slice(0, 600).toLowerCase();

  const [nerHits, summary, articleSentiment] = await Promise.all([
    runNer(env, titlePlusBody),
    summarizeArticle(env, body),
    sentimentOf(env, body.slice(0, 1200)),
  ]);

  const mentions: MentionResolved[] = [];
  const seenEntity = new Set<string>();
  for (const hit of nerHits) {
    const resolved = await resolveEntity(env, hit);
    if (!resolved || resolved.confidence < MENTION_CONFIDENCE_MIN) continue;
    if (seenEntity.has(resolved.entity_id)) continue;
    seenEntity.add(resolved.entity_id);
    const nameLower = hit.name.toLowerCase();
    const is_subject = (titleLower.includes(nameLower) || firstPara.includes(nameLower)) ? 1 : 0;
    const mention_count = (titlePlusBody.toLowerCase().match(new RegExp(`\\b${nameLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")) || []).length || 1;
    const sentiment = is_subject === 1 ? (articleSentiment ?? await sentimentOf(env, hit.context_quote || body.slice(0, 800))) : null;
    mentions.push({
      entity_id: resolved.entity_id,
      name: hit.name,
      confidence: resolved.confidence,
      is_subject: is_subject as 0 | 1,
      context_quote: hit.context_quote,
      sentiment,
      mention_count,
    });
  }
  return { mentions, summary, sentiment: articleSentiment };
}
