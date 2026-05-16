// Task #3: adverse-media analyzer.
//
// Strategy:
//   1. Pull recent mentions of the candidate name via GDELT (free,
//      keyless) — DOC-level full-text search across 65 languages.
//   2. (Optional) Augment with NewsAPI if NEWSAPI_KEY is set.
//   3. Filter to articles whose title/snippet contains a "negative"
//      keyword (fraud, lawsuit, investigation, etc).
//   4. Score each hit: severity = keyword_class × domain_reputability.
//   5. Cap at the top-K (default 10) by severity so a celebrity name
//      doesn't flood the findings table.
//
// Output: one `adverse_media` finding per surviving hit.

import type { Env } from "../types";

export interface AdverseMediaHit {
  title: string;
  url: string;
  domain: string;
  published_at?: string;
  snippet?: string;
  matched_keywords: string[];
  // Quotable evidence sentence — the substring of title/snippet that
  // contains the matched keyword, used by reviewers + the DD summary.
  evidence_text: string;
  severity: "low" | "medium" | "high" | "critical";
  severity_score: number; // 0..1
  reputability: number;   // 0..1
}

// Pull the sentence containing `keyword` from a longer text. Falls back
// to the keyword itself if the text doesn't split into sentences.
function extractEvidenceSentence(text: string, keyword: string): string {
  if (!text || !keyword) return keyword || "";
  const idx = text.toLowerCase().indexOf(keyword.toLowerCase());
  if (idx < 0) return keyword;
  // Walk backwards/forwards to sentence boundaries (., !, ?, newline).
  let start = idx;
  while (start > 0 && !/[.!?\n]/.test(text[start - 1])) start -= 1;
  let end = idx + keyword.length;
  while (end < text.length && !/[.!?\n]/.test(text[end])) end += 1;
  return text.slice(start, end + 1).trim().slice(0, 280);
}

// Curated negative-keyword classes. `weight` is the per-class severity
// contribution; multiplied by domain reputability to produce
// severity_score (0..1).
const KEYWORDS: Array<{ pattern: RegExp; weight: number; cls: string }> = [
  // Critical
  { pattern: /\b(fraud|embezzl|launder(ed|ing)?|bribe[ry]|corrupt(ion)?|terror|sanction(ed)?|indict(ed|ment)|guilty plea|convict(ed|ion))\b/i, weight: 0.95, cls: "criminal" },
  // High
  { pattern: /\b(lawsuit|sue[ds]?|sued|class action|sec (charges|filing)|fcpa|investigat(ed|ion)|prosecut(ed|or|ion)|wire fraud|insider trading|ponzi)\b/i, weight: 0.75, cls: "litigation" },
  // Medium
  { pattern: /\b(fired|resign(ed|ation)|ousted|step(ped)? down|misconduct|harass(ment)?|discriminat(ion|ed)|whistleblower|complaint)\b/i, weight: 0.55, cls: "misconduct" },
  // Lower
  { pattern: /\b(scandal|controvers(y|ial)|allegation|accus(ed|ation)|backlash|criticism|outcry)\b/i, weight: 0.35, cls: "reputational" },
];

let reputabilityMap: Record<string, number> | null = null;

async function loadReputability(): Promise<Record<string, number>> {
  if (reputabilityMap) return reputabilityMap;
  try {
    // Wrangler bundles JSON imports at build time. We strip `_comment`
    // (documentation only) and coerce the remaining keys to numbers.
    const mod = (await import("../../data/source-reputability.json")) as unknown as { default: Record<string, unknown> };
    const out: Record<string, number> = {};
    // Task #2 backward-compat: entries are now `{score,tier,country,notes}`
    // objects in source-reputability.json; legacy bare numbers still accepted.
    for (const [k, v] of Object.entries(mod.default ?? {})) {
      if (k.startsWith("_")) continue;
      if (typeof v === "number") out[k] = v;
      else if (v && typeof v === "object" && typeof (v as { score?: unknown }).score === "number") {
        out[k] = (v as { score: number }).score;
      }
    }
    reputabilityMap = out;
  } catch {
    reputabilityMap = {};
  }
  return reputabilityMap;
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
}

function classifySeverity(score: number): AdverseMediaHit["severity"] {
  if (score >= 0.75) return "critical";
  if (score >= 0.55) return "high";
  if (score >= 0.3) return "medium";
  return "low";
}

interface RawHit {
  title: string;
  url: string;
  published_at?: string;
  snippet?: string;
}

async function gdeltSearch(name: string, opts: { sinceDays?: number; max?: number }): Promise<RawHit[]> {
  const days = opts.sinceDays ?? 365;
  const max = opts.max ?? 50;
  // GDELT DOC v2 ArtList — JSON output.
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(`"${name}"`)}&mode=ArtList&maxrecords=${max}&format=json&timespan=${days}d&sort=DateDesc`;
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as { articles?: Array<Record<string, unknown>> };
    const arts = data.articles ?? [];
    return arts.map((a) => ({
      title: String(a.title ?? ""),
      url: String(a.url ?? ""),
      published_at: a.seendate ? formatGdeltDate(String(a.seendate)) : undefined,
      snippet: undefined,
    })).filter((a) => a.title && a.url);
  } catch {
    return [];
  }
}

function formatGdeltDate(s: string): string | undefined {
  // GDELT seendate is "YYYYMMDDTHHMMSSZ".
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) return undefined;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}

async function newsApiSearch(env: Env, name: string, max: number): Promise<RawHit[]> {
  const key = (env as Env & { NEWSAPI_KEY?: string }).NEWSAPI_KEY;
  if (!key) return [];
  const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(`"${name}"`)}&sortBy=publishedAt&pageSize=${Math.min(max, 50)}&language=en`;
  try {
    const res = await fetch(url, { headers: { "x-api-key": key, accept: "application/json" } });
    if (!res.ok) return [];
    const data = (await res.json()) as { articles?: Array<Record<string, unknown>> };
    return (data.articles ?? []).map((a) => ({
      title: String(a.title ?? ""),
      url: String(a.url ?? ""),
      published_at: typeof a.publishedAt === "string" ? a.publishedAt : undefined,
      snippet: typeof a.description === "string" ? a.description : undefined,
    })).filter((a) => a.title && a.url);
  } catch {
    return [];
  }
}

export async function scanAdverseMedia(
  env: Env,
  candidate: { name: string },
  opts: { topK?: number; sinceDays?: number } = {},
): Promise<AdverseMediaHit[]> {
  const topK = opts.topK ?? 10;
  const rep = await loadReputability();
  const [gd, na] = await Promise.all([
    gdeltSearch(candidate.name, { sinceDays: opts.sinceDays, max: 50 }),
    newsApiSearch(env, candidate.name, 30),
  ]);
  const byUrl = new Map<string, RawHit>();
  for (const h of [...gd, ...na]) {
    if (!byUrl.has(h.url)) byUrl.set(h.url, h);
  }
  const out: AdverseMediaHit[] = [];
  for (const h of byUrl.values()) {
    const text = `${h.title} ${h.snippet ?? ""}`;
    const matched: { keyword: string; weight: number; cls: string }[] = [];
    for (const k of KEYWORDS) {
      const m = text.match(k.pattern);
      if (m) matched.push({ keyword: m[0], weight: k.weight, cls: k.cls });
    }
    if (!matched.length) continue;
    const domain = hostOf(h.url);
    const reputability = rep[domain] ?? 0.4;
    const topWeight = matched.reduce((m, x) => (x.weight > m ? x.weight : m), 0);
    const score = Math.max(0, Math.min(1, topWeight * (0.5 + 0.5 * reputability)));
    // Quote the sentence around the highest-weighted keyword so the
    // reviewer can adjudicate without leaving the dashboard.
    const top = matched.reduce((m, x) => (x.weight > m.weight ? x : m), matched[0]);
    const evidence_text = extractEvidenceSentence(text, top.keyword);
    out.push({
      title: h.title,
      url: h.url,
      domain,
      published_at: h.published_at,
      snippet: h.snippet,
      matched_keywords: matched.map((m) => m.keyword),
      evidence_text,
      severity: classifySeverity(score),
      severity_score: Math.round(score * 1000) / 1000,
      reputability,
    });
  }
  out.sort((a, b) => b.severity_score - a.severity_score);
  return out.slice(0, topK);
}
