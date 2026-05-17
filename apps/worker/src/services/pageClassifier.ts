// Task #6: Page Classifier.
//
// Before the URL crawler turns a fetched page into a u_entities row, we
// classify what kind of page it actually is. News / blog / press-release
// pages are routed to `news_items` + `news_entity_mentions` instead of
// being misfiled as company/org rows on the Accounts / Customers
// dashboard (which is what was happening before).
//
// Order of operations (cheap → expensive):
//   1. URL pattern heuristics ("/news/", "/blog/", "/press/", dated
//      slugs like 2024/05/foo).
//   2. Open Graph type / Schema.org JSON-LD (`@type=NewsArticle`,
//      `@type=BlogPosting`).
//   3. Domain allow-list of known news / press-wire hosts.
//   4. Workers AI fallback with strict JSON schema (2 attempts, model
//      switch on retry, runAiWithTimeout 30s, cached in AI_CACHE R2).
//
// Returns `'other'` whenever the page is plainly a company site, team
// page, profile, etc. — that path stays on the existing crawler.

import type { Env } from "../types";
import { aiCacheGet, aiCachePut, sha256Hex } from "../ai/cache";
import { assertBudget } from "../ai/budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";

export type PageType =
  | "news_article"
  | "blog_post"
  | "press_release"
  | "directory"
  | "company_home"
  | "team_page"
  | "profile"
  | "other";

export interface PageClassification {
  page_type: PageType;
  confidence: number;          // 0..1
  source: "url" | "og" | "jsonld" | "domain" | "ai" | "default";
  signals: string[];           // human-readable list of matched heuristics
}

// Hosts that publish news. Anything fetched from these defaults to
// `news_article` even if the per-URL signals are ambiguous.
const NEWS_HOSTS = new Set<string>([
  "techcrunch.com", "theinformation.com", "bloomberg.com", "reuters.com",
  "wsj.com", "ft.com", "nytimes.com", "washingtonpost.com", "axios.com",
  "theverge.com", "wired.com", "arstechnica.com", "engadget.com",
  "businessinsider.com", "forbes.com", "fortune.com", "cnbc.com",
  "venturebeat.com", "thenextweb.com", "techstartups.com", "siliconangle.com",
  "bbc.com", "bbc.co.uk", "cnn.com", "apnews.com", "npr.org",
  "theguardian.com", "thetimes.co.uk", "economist.com",
]);

const PRESS_WIRE_HOSTS = new Set<string>([
  "prnewswire.com", "businesswire.com", "globenewswire.com",
  "newswire.com", "pressrelease.com", "einnews.com", "accesswire.com",
  "prweb.com", "marketwired.com",
]);

const NEWS_URL_PATTERNS: Array<{ rx: RegExp; type: PageType; tag: string }> = [
  { rx: /\/(20\d{2})\/(0?[1-9]|1[0-2])\/[^/]+\/?$/i, type: "news_article", tag: "url:dated_slug" },
  { rx: /\/news\/[^/]+\/?$/i, type: "news_article", tag: "url:/news/" },
  { rx: /\/article\/[^/]+\/?$/i, type: "news_article", tag: "url:/article/" },
  { rx: /\/story\/[^/]+\/?$/i, type: "news_article", tag: "url:/story/" },
  { rx: /\/press[-_/]release[s]?\/[^/]+\/?$/i, type: "press_release", tag: "url:/press-release/" },
  { rx: /\/press\/[^/]+\/?$/i, type: "press_release", tag: "url:/press/" },
  { rx: /\/newsroom\/[^/]+\/?$/i, type: "press_release", tag: "url:/newsroom/" },
  { rx: /\/blog\/[^/]+\/?$/i, type: "blog_post", tag: "url:/blog/" },
  { rx: /\/posts?\/[^/]+\/?$/i, type: "blog_post", tag: "url:/posts/" },
  { rx: /\/insights\/[^/]+\/?$/i, type: "blog_post", tag: "url:/insights/" },
];

const NEWS_INDEX_PATTERNS: RegExp[] = [
  /\/news\/?$/i, /\/press\/?$/i, /\/press-releases?\/?$/i,
  /\/newsroom\/?$/i, /\/blog\/?$/i, /\/insights\/?$/i,
];

// OG / JSON-LD detection runs over a small head-of-document slice to keep
// this cheap. We deliberately do NOT parse the whole DOM here — that
// happens later if/when the news pipeline enriches the article.
function headSlice(html: string): string {
  const idx = html.toLowerCase().indexOf("</head>");
  return idx > 0 ? html.slice(0, idx + 7) : html.slice(0, 16_000);
}

function detectOg(html: string): { type: PageType | null; tag: string | null } {
  const head = headSlice(html);
  // og:type="article" / "news_article" / "blog_post"
  const m = head.match(/<meta[^>]+property=["']og:type["'][^>]+content=["']([^"']+)["']/i);
  if (!m) return { type: null, tag: null };
  const v = m[1].toLowerCase().trim();
  if (v === "article" || v === "news_article" || v === "news") return { type: "news_article", tag: `og:type=${v}` };
  if (v === "blog" || v === "blog_post" || v === "blogposting") return { type: "blog_post", tag: `og:type=${v}` };
  if (v === "website" || v === "profile" || v === "company") return { type: "other", tag: `og:type=${v}` };
  return { type: null, tag: null };
}

function detectJsonLd(html: string): { type: PageType | null; tag: string | null } {
  const head = headSlice(html);
  // We don't need a real JSON parser — checking for the @type literal
  // covers the >99% of correctly-marked-up news pages. Cheap and safe.
  const blocks = head.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const blk of blocks) {
    const lower = blk.toLowerCase();
    if (lower.includes('"newsarticle"') || lower.includes('"reportagenewsarticle"')) {
      return { type: "news_article", tag: "jsonld:NewsArticle" };
    }
    if (lower.includes('"pressrelease"')) {
      return { type: "press_release", tag: "jsonld:PressRelease" };
    }
    if (lower.includes('"blogposting"') || lower.includes('"blog"')) {
      return { type: "blog_post", tag: "jsonld:BlogPosting" };
    }
    if (lower.includes('"article"')) {
      return { type: "news_article", tag: "jsonld:Article" };
    }
  }
  return { type: null, tag: null };
}

function hostOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}

function pathOf(url: string): string {
  try { return new URL(url).pathname; }
  catch { return ""; }
}

/**
 * Heuristic-only classification. Cheap, deterministic, no I/O. Used as
 * the first stage; returns `null` if no signal fires (caller may then
 * run the AI fallback).
 */
export function classifyPageHeuristic(url: string, html: string): PageClassification | null {
  const signals: string[] = [];
  const host = hostOf(url);
  const path = pathOf(url);

  // (1) URL pattern.
  for (const p of NEWS_URL_PATTERNS) {
    if (p.rx.test(path)) {
      signals.push(p.tag);
      // Domain reputation bump: a known news host + dated/news slug = high.
      const conf = NEWS_HOSTS.has(host) || PRESS_WIRE_HOSTS.has(host) ? 0.95 : 0.8;
      return { page_type: p.type, confidence: conf, source: "url", signals };
    }
  }
  for (const rx of NEWS_INDEX_PATTERNS) {
    if (rx.test(path)) {
      signals.push(`url_index:${rx.source}`);
      return { page_type: "directory", confidence: 0.7, source: "url", signals };
    }
  }

  // (2) OG type.
  const og = detectOg(html);
  if (og.type && og.tag) {
    signals.push(og.tag);
    if (og.type === "other") return { page_type: "other", confidence: 0.7, source: "og", signals };
    return { page_type: og.type, confidence: 0.85, source: "og", signals };
  }

  // (3) JSON-LD.
  const ld = detectJsonLd(html);
  if (ld.type && ld.tag) {
    signals.push(ld.tag);
    return { page_type: ld.type, confidence: 0.9, source: "jsonld", signals };
  }

  // (4) Domain allow-list (only fires if no URL signal already matched).
  if (PRESS_WIRE_HOSTS.has(host)) {
    signals.push(`host:press_wire:${host}`);
    return { page_type: "press_release", confidence: 0.85, source: "domain", signals };
  }
  if (NEWS_HOSTS.has(host) && path !== "/" && path.length > 1) {
    signals.push(`host:news:${host}`);
    return { page_type: "news_article", confidence: 0.75, source: "domain", signals };
  }

  return null;
}

// ----- AI fallback ---------------------------------------------------------

const PAGE_CLASS_SCHEMA = {
  type: "object",
  properties: {
    page_type: {
      type: "string",
      enum: [
        "news_article", "blog_post", "press_release",
        "directory", "company_home", "team_page", "profile", "other",
      ],
    },
    confidence: { type: "number" },
    reason: { type: "string" },
  },
  required: ["page_type", "confidence"],
} as const;

const AI_TIMEOUT_MS = 30_000;

async function runAiWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`ai_timeout:${label}:${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stripHtmlForClassifier(html: string): string {
  // Keep <title>, meta description, h1/h2, and the first ~1KB of body text.
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  const h1s = [...html.matchAll(/<h1[^>]*>([\s\S]*?)<\/h1>/gi)].slice(0, 3).map((m) => m[1]);
  const h2s = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)].slice(0, 5).map((m) => m[1]);
  const plain = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
  return [
    titleMatch ? `TITLE: ${titleMatch[1]}` : "",
    descMatch ? `DESC: ${descMatch[1]}` : "",
    h1s.length ? `H1: ${h1s.join(" | ")}` : "",
    h2s.length ? `H2: ${h2s.join(" | ")}` : "",
    `BODY: ${plain}`,
  ].filter(Boolean).join("\n").slice(0, 4000);
}

function parseClassifierResponse(res: unknown): { page_type: PageType; confidence: number } | null {
  const r = res as { response?: string; page_type?: PageType; confidence?: number };
  const direct = r?.page_type && typeof r.confidence === "number" ? r : null;
  if (direct) return { page_type: direct.page_type as PageType, confidence: Number(direct.confidence) };
  if (typeof r?.response === "string") {
    try {
      const j = JSON.parse(r.response) as { page_type?: PageType; confidence?: number };
      if (j?.page_type) return { page_type: j.page_type, confidence: Number(j.confidence ?? 0.5) };
    } catch { /* fall through */ }
  }
  return null;
}

async function classifyPageAi(env: Env, url: string, html: string, jobId?: string): Promise<PageClassification | null> {
  if (!env.AI) return null;
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return null;
  if (!(await limitAi(env))) return null;

  const text = stripHtmlForClassifier(html);
  const userPrompt = `URL: ${url}\nHOST: ${hostOf(url)}\n${text}`;
  const models = [
    env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast",
    "@cf/meta/llama-3.1-8b-instruct",
  ];

  for (let attempt = 0; attempt < models.length; attempt++) {
    const model = models[attempt];
    const cacheKey = await sha256Hex(`${model}:pageclass:${userPrompt}`);
    const cached = await aiCacheGet<{ page_type: PageType; confidence: number }>(env, cacheKey);
    if (cached) {
      trackAi(env, { purpose: "classify_types", model, cacheHit: true, jobId });
      return { page_type: cached.page_type, confidence: cached.confidence, source: "ai", signals: [`ai:cache:${model}`] };
    }
    const t0 = Date.now();
    try {
      const res = (await runAiWithTimeout(env.AI.run(model, {
        messages: [
          { role: "system", content: "Classify a web page into one of: news_article, blog_post, press_release, directory, company_home, team_page, profile, other. A news_article is a third-party news report about people/companies. A press_release is a company's own announcement. Directories list many entities. Reply strict JSON {page_type, confidence:0..1, reason}." },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_schema", json_schema: PAGE_CLASS_SCHEMA },
      }), AI_TIMEOUT_MS, "page_classify")) as { response?: string };
      const parsed = parseClassifierResponse(res);
      trackAi(env, { purpose: "classify_types", model, ms: Date.now() - t0, neurons: 0.05, jobId });
      if (parsed) {
        await aiCachePut(env, cacheKey, parsed);
        return { page_type: parsed.page_type, confidence: parsed.confidence, source: "ai", signals: [`ai:${model}`] };
      }
    } catch (e) {
      console.warn(`classifyPageAi attempt ${attempt + 1} failed`, (e as Error).message);
    }
  }
  return null;
}

/**
 * Public entry point. Runs heuristics first; falls back to AI if no
 * heuristic fires. Returns `other` (default) if AI is unavailable or
 * also fails — the caller should then take the normal entity path.
 */
export async function classifyPage(env: Env, url: string, html: string, jobId?: string): Promise<PageClassification> {
  const heuristic = classifyPageHeuristic(url, html);
  if (heuristic) return heuristic;
  const ai = await classifyPageAi(env, url, html, jobId);
  if (ai) return ai;
  return { page_type: "other", confidence: 0.5, source: "default", signals: ["no_signal"] };
}

/**
 * Convenience predicate: should the URL crawler route this page to
 * news_items instead of creating an entity row?
 */
export function isNewsLike(pt: PageType): boolean {
  return pt === "news_article" || pt === "blog_post" || pt === "press_release";
}
