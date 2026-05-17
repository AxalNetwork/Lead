// Stylometric writing-style pivot.
//
// For each pair of (known platform with public text) and (candidate
// platform with public text), build a 32-feature style vector and
// compute cosine similarity. Pairs above 0.92 cosine emit a stylometric
// hit. This is a corroborating signal, not a standalone one — base
// confidence caps at 0.78.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGet, pastDeadline, parallelMap } from "./_util";
import { getPlatform, type PlatformSlug } from "../platforms";

// Public-text URLs we can pull cheaply per platform. Each returns ≥1 short
// public sample (about/bio/comments) suitable for stylometric vectorization.
function textSourceUrl(platform: PlatformSlug, handle: string): string | null {
  switch (platform) {
    case "hackernews":    return `https://hacker-news.firebaseio.com/v0/user/${encodeURIComponent(handle)}.json`;
    case "reddit":        return `https://www.reddit.com/user/${encodeURIComponent(handle)}/about.json`;
    case "github":        return `https://api.github.com/users/${encodeURIComponent(handle)}`;
    case "devto":         return `https://dev.to/api/users/by_username?url=${encodeURIComponent(handle)}`;
    case "medium":        return `https://medium.com/@${encodeURIComponent(handle)}`;
    case "substack":      return `https://${encodeURIComponent(handle)}.substack.com/about`;
    default:              return null;
  }
}

function extractText(platform: PlatformSlug, body: string): string {
  if (!body) return "";
  try {
    if (platform === "hackernews") { const o = JSON.parse(body); return String(o?.about ?? ""); }
    if (platform === "reddit")     { const o = JSON.parse(body); return String(o?.data?.subreddit?.public_description ?? ""); }
    if (platform === "github")     { const o = JSON.parse(body); return String(o?.bio ?? ""); }
    if (platform === "devto")      { const o = JSON.parse(body); return String(o?.summary ?? ""); }
  } catch { /* HTML fallthrough */ }
  // Naive strip-tags + collapse whitespace for HTML responses.
  return body.replace(/<script[\s\S]*?<\/script>/gi, " ")
             .replace(/<style[\s\S]*?<\/style>/gi, " ")
             .replace(/<[^>]+>/g, " ")
             .replace(/\s+/g, " ")
             .slice(0, 4000)
             .trim();
}

export async function runWritingStyle(env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  const samplePlatforms: PlatformSlug[] = ["hackernews", "reddit", "github", "devto", "medium", "substack"];
  const known = facts.knownHandles.filter((kh) => samplePlatforms.includes(kh.platform as PlatformSlug));
  if (!known.length) return [];

  // Gather text samples for known handles.
  const samples: Array<{ platform: PlatformSlug; handle: string; vector: number[]; text: string }> = [];
  await parallelMap(known.slice(0, 5), 3, async (kh) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    const url = textSourceUrl(kh.platform as PlatformSlug, kh.handle);
    if (!url) return;
    const r = await simpleGet(url, { timeoutMs: 4000 });
    if (!r.ok) return;
    const text = extractText(kh.platform as PlatformSlug, r.text);
    if (text.length < 80) return;
    samples.push({ platform: kh.platform as PlatformSlug, handle: kh.handle, vector: featureVector(text), text });
  });

  if (!samples.length) return [];

  // Persist a vector for the highest-quality sample (longest text).
  samples.sort((a, b) => b.text.length - a.text.length);
  const ref = samples[0];
  try {
    await env.DB.prepare(
      `INSERT INTO stylometric_vectors (id, entity_id, source_platform, source_handle, vector_json, word_count)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(entity_id, source_platform, source_handle) DO UPDATE SET
         vector_json = excluded.vector_json,
         word_count  = excluded.word_count,
         computed_at = datetime('now')`,
    ).bind(crypto.randomUUID(), facts.entityId, ref.platform, ref.handle, JSON.stringify(ref.vector), ref.text.split(/\s+/).length).run();
  } catch (e) { console.warn("stylometric persist failed", (e as Error).message); }

  // Compare reference vs other stored vectors for OTHER entities sharing
  // a sample platform — surface near-matches as stylometric hits.
  const hits: PivotHit[] = [];
  const r = await env.DB.prepare(
    `SELECT entity_id, source_platform, source_handle, vector_json FROM stylometric_vectors
       WHERE entity_id != ? LIMIT 500`,
  ).bind(facts.entityId).all<{ entity_id: string; source_platform: string; source_handle: string; vector_json: string }>();
  for (const row of r.results ?? []) {
    let v: number[];
    try { v = JSON.parse(row.vector_json); } catch { continue; }
    if (!Array.isArray(v) || v.length !== ref.vector.length) continue;
    const sim = cosine(ref.vector, v);
    if (sim >= 0.92) {
      const def = getPlatform(row.source_platform);
      hits.push({
        platform: row.source_platform as PlatformSlug,
        handle: row.source_handle,
        url: def ? def.urlOf(row.source_handle) : null as unknown as string,
        link_method: "stylometric",
        base_confidence: Math.min(0.78, 0.45 + (sim - 0.92) * 4),
        evidence_json: { cosine: sim, other_entity_id: row.entity_id, ref_platform: ref.platform, ref_handle: ref.handle },
      });
    }
  }
  return hits;
}

// 32-feature stylometric vector. Lightweight, fast, language-agnostic-ish.
//   0..7  : letter-frequency ratios for 8 common letters
//   8..15 : punctuation density per 100 chars: . , ! ? ; : — ()
//   16    : avg word length
//   17    : avg sentence length (words)
//   18    : type-token ratio (vocab / words)
//   19    : pct words >= 7 chars
//   20    : pct words all caps
//   21    : pct words starting with capital
//   22    : digit density
//   23    : URL density per 100 words
//   24    : emoji-ish density (non-ascii printable)
//   25    : question-rate
//   26    : exclamation-rate
//   27    : paragraph rate (newlines per 100 chars)
//   28    : avg syllables/word (approx, vowel groups)
//   29    : pct stopword tokens (English subset)
//   30    : hapax-legomenon ratio (once-only / vocab)
//   31    : Flesch-style readability scaled to [0,1]
function featureVector(text: string): number[] {
  const t = text || "";
  const chars = [...t];
  const len = Math.max(1, chars.length);
  const words = (t.match(/\b[\p{L}\p{N}'_-]+\b/gu) ?? []).filter(Boolean);
  const w = Math.max(1, words.length);
  const lower = t.toLowerCase();
  const letters = "etaoinsh";
  const f = new Array<number>(32).fill(0);

  for (let i = 0; i < 8; i++) {
    const c = letters[i];
    let n = 0; for (let k = 0; k < lower.length; k++) if (lower[k] === c) n++;
    f[i] = n / len;
  }
  const puncts = [".", ",", "!", "?", ";", ":", "—", "("];
  for (let i = 0; i < puncts.length; i++) {
    let n = 0; for (const ch of chars) if (ch === puncts[i]) n++;
    f[8 + i] = (n / len) * 100;
  }
  const avgWordLen = words.reduce((s, w0) => s + w0.length, 0) / w;
  f[16] = avgWordLen;
  const sentences = t.split(/[.!?]+\s+/).filter(Boolean).length || 1;
  f[17] = w / sentences;
  const vocab = new Set(words.map((x) => x.toLowerCase()));
  f[18] = vocab.size / w;
  f[19] = words.filter((x) => x.length >= 7).length / w;
  f[20] = words.filter((x) => x === x.toUpperCase() && /[A-Z]/.test(x)).length / w;
  f[21] = words.filter((x) => /^[A-Z]/.test(x)).length / w;
  let digits = 0; for (const ch of chars) if (ch >= "0" && ch <= "9") digits++;
  f[22] = digits / len;
  const urls = (t.match(/https?:\/\//g) ?? []).length;
  f[23] = (urls / w) * 100;
  let emoji = 0; for (const ch of chars) if (ch.codePointAt(0)! > 0x1F300) emoji++;
  f[24] = emoji / len;
  const qs = (t.match(/\?/g) ?? []).length;
  const ex = (t.match(/!/g) ?? []).length;
  f[25] = qs / sentences;
  f[26] = ex / sentences;
  const newlines = (t.match(/\n/g) ?? []).length;
  f[27] = (newlines / len) * 100;
  const sylls = words.reduce((s, w0) => s + Math.max(1, (w0.toLowerCase().match(/[aeiouy]+/g) ?? []).length), 0);
  f[28] = sylls / w;
  const stop = new Set(["the","a","an","and","or","but","of","to","in","is","it","that","for","on","with","as","be","this","by","at","are","was","were","i","you","he","she","they","we"]);
  f[29] = words.filter((x) => stop.has(x.toLowerCase())).length / w;
  const counts = new Map<string, number>();
  for (const wd of words) counts.set(wd.toLowerCase(), (counts.get(wd.toLowerCase()) ?? 0) + 1);
  let hapax = 0; for (const n of counts.values()) if (n === 1) hapax++;
  f[30] = hapax / Math.max(1, vocab.size);
  const flesch = 206.835 - 1.015 * (w / sentences) - 84.6 * (sylls / w);
  f[31] = Math.max(0, Math.min(1, flesch / 100));
  return f;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den === 0 ? 0 : dot / den;
}

export { featureVector, cosine };
