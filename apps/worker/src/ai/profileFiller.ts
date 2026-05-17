// Task #3: AI Profile Filler.
//
// Given an entity with at least one of {website, linkedin, crunchbase, name+org},
// fetches the firm's homepage + standard subpages, runs Workers AI with a strict
// JSON schema to extract thesis / sectors / stages / geo / check size / team /
// portfolio, and persists every non-null field as a `facts` row with
// source_type='ai_profile_filler:v1'. Team members + portfolio companies are
// inserted as their own entities through the dual-write path with proper
// rel_edges. 7-day per-entity cap unless force=true.
//
// Each phase is a discrete async function so the calling workflow can wrap
// each in step.do(...) for checkpoint-and-resume durability.

import type { Env } from "../types";
import { aiCacheGet, aiCachePut, sha256Hex } from "./cache";
import { assertBudget } from "./budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";
import { fetchPage } from "../scraper/fetcher";
import { insertFact, insertFactsBatch } from "../entities/facts";
import { addTag } from "../entities/tags";
import { syncFirmToEntity } from "../entities/dualwrite";

export const PROFILE_FILLER_VERSION = "ai_profile_filler:v1";
const SUBPATHS = [
  "/", "/about", "/team", "/people", "/portfolio", "/companies",
  "/investments", "/customers", "/case-studies", "/contact",
];
const HTML_R2_TTL_SECONDS = 24 * 60 * 60;
const FILL_COOLDOWN_SECONDS = 7 * 24 * 60 * 60;
const AI_TIMEOUT_MS = 30_000;
const PAGE_TEXT_CAP = 12_000;
const HOMEPAGE_TEXT_CAP = 4_000;

const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    entity_kind: { type: "string" },
    thesis: { type: "string" },
    mission: { type: "string" },
    founded_year: { type: "number" },
    headquarters_city: { type: "string" },
    headquarters_country_iso2: { type: "string" },
    other_offices: { type: "array", items: { type: "string" } },
    team_members: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          title: { type: "string" },
          linkedin_url: { type: "string" },
        },
        required: ["name"],
      },
    },
    portfolio_companies: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, website: { type: "string" } },
        required: ["name"],
      },
    },
    customers_named: { type: "array", items: { type: "string" } },
    sectors: { type: "array", items: { type: "string" } },
    stages: { type: "array", items: { type: "string" } },
    geo_focus: { type: "string" },
    check_size_min_usd: { type: "number" },
    check_size_max_usd: { type: "number" },
    fund_size_usd: { type: "number" },
    aum_usd: { type: "number" },
    contact_email: { type: "string" },
    twitter_handle: { type: "string" },
    linkedin_company_id: { type: "string" },
  },
} as const;

const NAME_SAFEGUARD_RE = /^[A-Z][A-Za-z0-9 .,'&\-()]{1,60}$/;

export interface FillOptions {
  force?: boolean;
  triggeredBy?: string;
}

export interface FillResult {
  ok: boolean;
  entityId: string;
  reason?: string;
  facts_written?: number;
  team_added?: number;
  portfolio_added?: number;
  pages_fetched?: number;
  name_corrected?: boolean;
}

interface EntityRow {
  id: string;
  kind: string;
  display_name: string | null;
  primary_url: string | null;
  primary_domain: string | null;
}

interface FetchedPage {
  url: string;
  status: number;
  text: string;
}

interface ExtractedProfile {
  entity_kind?: string;
  thesis?: string;
  mission?: string;
  founded_year?: number;
  headquarters_city?: string;
  headquarters_country_iso2?: string;
  other_offices?: string[];
  team_members?: Array<{ name: string; title?: string; linkedin_url?: string }>;
  portfolio_companies?: Array<{ name: string; website?: string }>;
  customers_named?: string[];
  sectors?: string[];
  stages?: string[];
  geo_focus?: string;
  check_size_min_usd?: number;
  check_size_max_usd?: number;
  fund_size_usd?: number;
  aum_usd?: number;
  contact_email?: string;
  twitter_handle?: string;
  linkedin_company_id?: string;
}

function stripHtml(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveSiteUrl(ent: EntityRow): string | null {
  if (ent.primary_url) {
    try {
      const u = new URL(ent.primary_url);
      return `${u.protocol}//${u.hostname}`;
    } catch { /* fall through */ }
  }
  if (ent.primary_domain) {
    const d = ent.primary_domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (d) return `https://${d}`;
  }
  return null;
}

async function runAiJson<T>(
  env: Env,
  systemPrompt: string,
  userPrompt: string,
  schema: unknown,
  cacheKeyMaterial: string,
  jobId?: string,
): Promise<T | null> {
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const cacheKey = await sha256Hex(`${model}:${PROFILE_FILLER_VERSION}:${cacheKeyMaterial}`);
  const cached = await aiCacheGet<T>(env, cacheKey);
  if (cached) {
    trackAi(env, { purpose: "extraction", model, cacheHit: true, jobId });
    return cached;
  }
  if (!env.AI) return null;
  const okBudget = await assertBudget(env, "ai");
  if (!okBudget.ok) return null;
  if (!(await limitAi(env))) return null;
  const t0 = Date.now();
  const attempt = async (temperature: number): Promise<T | null> => {
    try {
      const racePromise = env.AI!.run(model, {
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_schema", json_schema: schema },
        temperature,
      } as unknown as Record<string, unknown>) as Promise<{ response?: string } & Record<string, unknown>>;
      const res = await Promise.race<{ response?: string } & Record<string, unknown>>([
        racePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ai_timeout")), AI_TIMEOUT_MS),
        ),
      ]);
      if (typeof res?.response === "string") {
        try { return JSON.parse(res.response) as T; } catch { return null; }
      }
      // Some bindings return the parsed object directly.
      if (res && typeof res === "object") return res as T;
      return null;
    } catch (e) {
      console.warn("profileFiller runAiJson failed", (e as Error).message);
      return null;
    }
  };
  let out = await attempt(0.3);
  if (!out) out = await attempt(0.05);
  trackAi(env, { purpose: "extraction", model, ms: Date.now() - t0, neurons: Math.max(1, Math.ceil(userPrompt.length / 4) * 0.011), jobId });
  if (out) await aiCachePut(env, cacheKey, out);
  return out;
}

// ---- Step A: Web fetch with R2 24h cache --------------------------------

async function r2HtmlGet(env: Env, key: string): Promise<string | null> {
  if (!env.RAW_HTML) return null;
  try {
    const obj = await env.RAW_HTML.get(key);
    if (!obj) return null;
    return await obj.text();
  } catch { return null; }
}

async function r2HtmlPut(env: Env, key: string, text: string): Promise<void> {
  if (!env.RAW_HTML) return;
  try {
    await env.RAW_HTML.put(key, text, {
      httpMetadata: { contentType: "text/html; charset=utf-8" },
      customMetadata: { stored_at: new Date().toISOString(), ttl_seconds: String(HTML_R2_TTL_SECONDS) },
    });
  } catch { /* swallow */ }
}

export async function fetchSitePages(env: Env, siteBaseUrl: string): Promise<FetchedPage[]> {
  const out: FetchedPage[] = [];
  for (const path of SUBPATHS) {
    const url = new URL(path, siteBaseUrl).toString();
    const cacheKey = `profile_filler/${await sha256Hex(url)}.html`;
    let html = await r2HtmlGet(env, cacheKey);
    let status = 200;
    if (!html) {
      const r = await fetchPage(env, url, { timeoutMs: 15_000, minIntervalMs: 4_000 });
      status = r.status;
      if (!r.ok || !r.html || status >= 400) continue;
      html = r.html;
      await r2HtmlPut(env, cacheKey, html);
    }
    const text = stripHtml(html).slice(0, PAGE_TEXT_CAP);
    if (text.length < 200) continue;
    out.push({ url, status, text });
  }
  return out;
}

// ---- Step B: canonical name extraction ---------------------------------

export async function extractCanonicalName(env: Env, homepageText: string): Promise<string | null> {
  if (!homepageText) return null;
  const text = homepageText.slice(0, HOMEPAGE_TEXT_CAP);
  const cacheKeyMaterial = `name:${text}`;
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  };
  const out = await runAiJson<{ name?: string }>(
    env,
    "Extract the company or firm's canonical brand name from the page text. Return strict JSON {\"name\": \"<name>\"}. No commentary. If no clear brand name, return {\"name\": \"\"}.",
    `Page text:\n${text}`,
    schema,
    cacheKeyMaterial,
  );
  const name = (out?.name ?? "").trim();
  if (!name) return null;
  return name;
}

function isMateriallyDifferentName(oldName: string | null | undefined, newName: string): boolean {
  if (!oldName) return true;
  const a = oldName.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  const b = newName.trim().toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!a || !b) return false;
  if (a === b) return false;
  // Substring containment = not material (e.g., "First Round" vs "First Round Capital").
  if (a.includes(b) || b.includes(a)) return false;
  return true;
}

// ---- Step C: structured extraction --------------------------------------

export async function extractStructuredProfile(env: Env, pages: FetchedPage[]): Promise<ExtractedProfile | null> {
  if (!pages.length) return null;
  const combined = pages.map((p) => `### ${p.url}\n${p.text}`).join("\n\n").slice(0, 18_000);
  const cacheKeyMaterial = `structured:${combined}`;
  const out = await runAiJson<ExtractedProfile>(
    env,
    "Extract a structured firm/company profile from the page text below. Return strict JSON conforming exactly to the provided schema. Omit fields you cannot ground in the text — do not guess. For sectors and stages use short lowercase slugs (e.g. 'fintech', 'seed'). For headquarters_country_iso2 use a 2-letter ISO code. For monetary fields use USD numbers without commas.",
    combined,
    PROFILE_SCHEMA,
    cacheKeyMaterial,
  );
  return out;
}

// ---- Step E: write to DB -----------------------------------------------

async function findOrCreatePortfolioEntity(env: Env, name: string, website: string | null, source: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed) return null;
  let domain: string | null = null;
  if (website) {
    try { domain = new URL(website).hostname.toLowerCase().replace(/^www\./, ""); } catch { /* ignore */ }
  }
  // Try existing match by domain first.
  if (domain) {
    const hit = await env.DB.prepare(
      `SELECT id FROM u_entities WHERE kind='org' AND status='active' AND lower(primary_domain) = ? LIMIT 1`,
    ).bind(domain).first<{ id: string }>().catch(() => null);
    if (hit?.id) return hit.id;
  }
  // Match by display_name (case-insensitive) if no domain.
  const hitByName = await env.DB.prepare(
    `SELECT id FROM u_entities WHERE kind='org' AND status='active' AND lower(display_name) = ? LIMIT 1`,
  ).bind(trimmed.toLowerCase()).first<{ id: string }>().catch(() => null);
  if (hitByName?.id) return hitByName.id;

  // Create new org entity via dual-write firm sync (firm-like minimal input).
  return await syncFirmToEntity(env, {
    id: 0,
    name: trimmed,
    domain,
    website: website ?? null,
    source_domain: domain,
  } as unknown as Parameters<typeof syncFirmToEntity>[1], source);
}

async function findOrCreatePersonEntity(env: Env, name: string, linkedin: string | null, source: string): Promise<string | null> {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2) return null;
  let linkedinKey: string | null = null;
  if (linkedin) {
    try {
      const u = new URL(linkedin);
      linkedinKey = u.pathname.replace(/\/+$/, "").toLowerCase();
    } catch { /* ignore */ }
  }
  if (linkedinKey) {
    const hit = await env.DB.prepare(
      `SELECT id FROM u_entities WHERE kind='person' AND status='active' AND lower(primary_linkedin_key) = ? LIMIT 1`,
    ).bind(linkedinKey).first<{ id: string }>().catch(() => null);
    if (hit?.id) return hit.id;
  }
  const hit = await env.DB.prepare(
    `SELECT id FROM u_entities WHERE kind='person' AND status='active' AND lower(display_name) = ? LIMIT 1`,
  ).bind(trimmed.toLowerCase()).first<{ id: string }>().catch(() => null);
  if (hit?.id) return hit.id;

  // Create a new person entity directly. Mirror what dualwrite would do.
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      `INSERT INTO u_entities (id, kind, display_name, primary_linkedin_key, status, quality_score, created_at, updated_at)
       VALUES (?, 'person', ?, ?, 'active', 30, ?, ?)`,
    ).bind(id, trimmed, linkedinKey, now, now).run();
  } catch (e) {
    console.warn("findOrCreatePersonEntity insert failed", (e as Error).message);
    return null;
  }
  await insertFact(env, {
    entity_id: id, predicate: "name", value_text: trimmed,
    source_kind: "ai", source, confidence: 0.7,
  });
  if (linkedin) {
    try {
      await env.DB.prepare(
        `INSERT INTO entity_channels (entity_id, kind, canonical, source, is_primary)
         VALUES (?, 'linkedin', ?, ?, 1)
         ON CONFLICT DO NOTHING`,
      ).bind(id, linkedin, source).run();
    } catch { /* table may differ; non-fatal */ }
  }
  return id;
}

async function ensureRelEdge(env: Env, src: string, dst: string, kind: string, source: string): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO rel_edges (id, src_entity_id, dst_entity_id, kind, source)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(src_entity_id, dst_entity_id, kind, IFNULL(valid_from,'')) DO NOTHING`,
    ).bind(crypto.randomUUID(), src, dst, kind, source).run();
  } catch (e) {
    console.warn("ensureRelEdge failed", kind, (e as Error).message);
  }
}

export async function writeProfileToDb(
  env: Env,
  entityId: string,
  profile: ExtractedProfile,
  evidenceUrl: string,
): Promise<{ facts_written: number; team_added: number; portfolio_added: number }> {
  const source = PROFILE_FILLER_VERSION;
  const patches: Array<{ predicate: string; value_text?: string | null; value_number?: number | null; value_json?: unknown }> = [];
  if (profile.thesis) patches.push({ predicate: "thesis", value_text: profile.thesis });
  if (profile.mission) patches.push({ predicate: "mission", value_text: profile.mission });
  if (profile.founded_year) patches.push({ predicate: "founded_year", value_number: profile.founded_year });
  if (profile.headquarters_city) patches.push({ predicate: "headquarters_city", value_text: profile.headquarters_city });
  if (profile.headquarters_country_iso2) patches.push({ predicate: "headquarters_country", value_text: profile.headquarters_country_iso2.toUpperCase() });
  if (profile.other_offices?.length) patches.push({ predicate: "other_offices", value_json: profile.other_offices });
  if (profile.geo_focus) patches.push({ predicate: "geo_focus", value_text: profile.geo_focus });
  if (profile.check_size_min_usd) patches.push({ predicate: "check_size_min_usd", value_number: profile.check_size_min_usd });
  if (profile.check_size_max_usd) patches.push({ predicate: "check_size_max_usd", value_number: profile.check_size_max_usd });
  if (profile.fund_size_usd) patches.push({ predicate: "fund_size_usd", value_number: profile.fund_size_usd });
  if (profile.aum_usd) patches.push({ predicate: "aum_usd", value_number: profile.aum_usd });
  if (profile.contact_email) patches.push({ predicate: "contact_email", value_text: profile.contact_email });
  if (profile.twitter_handle) patches.push({ predicate: "twitter_handle", value_text: profile.twitter_handle.replace(/^@/, "") });
  if (profile.linkedin_company_id) patches.push({ predicate: "linkedin_company_id", value_text: profile.linkedin_company_id });
  if (profile.customers_named?.length) patches.push({ predicate: "customers_named", value_json: profile.customers_named });

  const facts_written = await insertFactsBatch(env, entityId, patches, source, "ai", evidenceUrl);

  if (profile.sectors?.length) {
    for (const s of profile.sectors) {
      const slug = String(s).toLowerCase().trim().replace(/[^a-z0-9\- ]/g, "").replace(/\s+/g, "-");
      if (slug) await addTag(env, { entity_id: entityId, taxonomy: "sector", slug, source });
    }
  }
  if (profile.stages?.length) {
    for (const s of profile.stages) {
      const slug = String(s).toLowerCase().trim().replace(/[^a-z0-9\- ]/g, "").replace(/\s+/g, "-");
      if (slug) await addTag(env, { entity_id: entityId, taxonomy: "stage", slug, source });
    }
  }

  // Team members → person entities + works_at edges.
  let team_added = 0;
  for (const tm of (profile.team_members ?? []).slice(0, 50)) {
    if (!tm.name) continue;
    const personId = await findOrCreatePersonEntity(env, tm.name, tm.linkedin_url ?? null, source);
    if (!personId) continue;
    await ensureRelEdge(env, personId, entityId, "works_at", source);
    if (tm.title) {
      await insertFact(env, {
        entity_id: personId, predicate: "title", value_text: tm.title,
        source_kind: "ai", source, evidence_url: evidenceUrl, confidence: 0.7,
      });
    }
    team_added += 1;
  }

  // Portfolio companies → org entities + invested_in edges (investor case).
  let portfolio_added = 0;
  for (const pc of (profile.portfolio_companies ?? []).slice(0, 200)) {
    if (!pc.name) continue;
    const orgId = await findOrCreatePortfolioEntity(env, pc.name, pc.website ?? null, source);
    if (!orgId) continue;
    await ensureRelEdge(env, entityId, orgId, "invested_in", source);
    portfolio_added += 1;
  }

  return { facts_written, team_added, portfolio_added };
}

// ---- Step B (write): canonical name correction --------------------------

export async function maybeApplyNameCorrection(
  env: Env,
  ent: EntityRow,
  aiName: string,
  evidenceUrl: string,
): Promise<boolean> {
  if (!isMateriallyDifferentName(ent.display_name, aiName)) return false;
  if (!NAME_SAFEGUARD_RE.test(aiName)) {
    // Safeguard rejected; log a fact but DO NOT mutate the row.
    await insertFact(env, {
      entity_id: ent.id, predicate: "name_correction_proposed",
      value_json: { old: ent.display_name, new: aiName, applied: false, reason: "safeguard_regex_failed" },
      source_kind: "ai", source: PROFILE_FILLER_VERSION, evidence_url: evidenceUrl, confidence: 0.3,
    });
    return false;
  }
  await env.DB.prepare(
    `UPDATE u_entities SET display_name = ?, updated_at = ? WHERE id = ?`,
  ).bind(aiName, new Date().toISOString(), ent.id).run();
  await insertFact(env, {
    entity_id: ent.id, predicate: "name_corrected_by_ai",
    value_json: { old: ent.display_name, new: aiName },
    source_kind: "ai", source: PROFILE_FILLER_VERSION, evidence_url: evidenceUrl, confidence: 0.9,
  });
  return true;
}

// ---- 7-day cap ---------------------------------------------------------

function cooldownKey(entityId: string): string { return `pf:last:${entityId}`; }

export async function isWithinCooldown(env: Env, entityId: string): Promise<{ blocked: boolean; last_at?: string }> {
  if (!env.SCRAPE_CACHE) return { blocked: false };
  const raw = await env.SCRAPE_CACHE.get(cooldownKey(entityId));
  if (!raw) return { blocked: false };
  return { blocked: true, last_at: raw };
}

export async function stampCooldown(env: Env, entityId: string): Promise<void> {
  if (!env.SCRAPE_CACHE) return;
  await env.SCRAPE_CACHE.put(cooldownKey(entityId), new Date().toISOString(), {
    expirationTtl: FILL_COOLDOWN_SECONDS,
  });
}

// ---- Step F: search-engine corroboration (lightweight) -----------------

async function braveSearch(env: Env, query: string): Promise<Array<{ title: string; description: string; url: string }>> {
  const key = env.BRAVE_SEARCH_KEY ?? env.BRAVE_API_KEY;
  if (!key) return [];
  try {
    const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
      headers: { "X-Subscription-Token": key, "Accept": "application/json" },
    });
    if (!r.ok) return [];
    const j = await r.json() as { web?: { results?: Array<{ title?: string; description?: string; url?: string }> } };
    return (j.web?.results ?? []).slice(0, 5).map((x) => ({ title: x.title ?? "", description: x.description ?? "", url: x.url ?? "" }));
  } catch { return []; }
}

export async function corroborateClaims(
  env: Env,
  entityId: string,
  canonicalName: string,
  profile: ExtractedProfile,
  evidenceUrl: string,
): Promise<number> {
  const results = await braveSearch(env, `${canonicalName} firm`);
  if (!results.length) return 0;
  // Persist top snippets as a fact so the dashboard can show corroboration.
  await insertFact(env, {
    entity_id: entityId, predicate: "search_corroboration",
    value_json: results.map((r) => ({ title: r.title, url: r.url, snippet: r.description.slice(0, 240) })),
    source_kind: "ai", source: PROFILE_FILLER_VERSION, evidence_url: evidenceUrl, confidence: 0.6,
  });
  // Best-effort AI contradiction check (small claim set, single AI call).
  const claims: Record<string, unknown> = {};
  if (profile.thesis) claims.thesis = profile.thesis.slice(0, 200);
  if (profile.headquarters_city) claims.headquarters_city = profile.headquarters_city;
  if (profile.founded_year) claims.founded_year = profile.founded_year;
  if (profile.geo_focus) claims.geo_focus = profile.geo_focus;
  if (!Object.keys(claims).length) return results.length;
  const userPrompt = `Claims about ${canonicalName}:\n${JSON.stringify(claims)}\n\nSearch results:\n${results.map((r) => `- ${r.title}: ${r.description}`).join("\n")}\n\nReturn strict JSON: {\"contradicted\": [\"<claim_key>\", ...]}.`;
  const out = await runAiJson<{ contradicted?: string[] }>(
    env,
    "You verify whether the search results contradict the listed claims. Only mark a claim as contradicted when the evidence is explicit.",
    userPrompt,
    { type: "object", properties: { contradicted: { type: "array", items: { type: "string" } } }, required: ["contradicted"] },
    `corroborate:${canonicalName}:${JSON.stringify(claims)}`,
  );
  if (out?.contradicted?.length) {
    await insertFact(env, {
      entity_id: entityId, predicate: "search_contradicted_claims",
      value_json: out.contradicted,
      source_kind: "ai", source: PROFILE_FILLER_VERSION, evidence_url: evidenceUrl, confidence: 0.5,
    });
  }
  return results.length;
}

// ---- Orchestrator ------------------------------------------------------

export async function fillProfile(env: Env, entityId: string, opts: FillOptions = {}): Promise<FillResult> {
  const ent = await env.DB.prepare(
    `SELECT id, kind, display_name, primary_url, primary_domain FROM u_entities WHERE id = ? AND status = 'active'`,
  ).bind(entityId).first<EntityRow>();
  if (!ent) return { ok: false, entityId, reason: "entity_not_found" };

  if (!opts.force) {
    const cool = await isWithinCooldown(env, entityId);
    if (cool.blocked) return { ok: false, entityId, reason: "cooldown_active", facts_written: 0 };
  }
  const budget = await assertBudget(env, "ai");
  if (!budget.ok) return { ok: false, entityId, reason: `budget_blocked:${budget.reason ?? "ai"}` };

  const siteUrl = resolveSiteUrl(ent);
  if (!siteUrl) return { ok: false, entityId, reason: "no_website" };

  // Step A: fetch pages.
  const pages = await fetchSitePages(env, siteUrl);
  if (!pages.length) {
    await stampCooldown(env, entityId);
    return { ok: false, entityId, reason: "no_pages_fetched", pages_fetched: 0 };
  }

  // Step B: canonical name.
  const homepage = pages[0];
  let name_corrected = false;
  const aiName = await extractCanonicalName(env, homepage.text);
  if (aiName) {
    name_corrected = await maybeApplyNameCorrection(env, ent, aiName, homepage.url);
  }
  const canonicalName = name_corrected && aiName ? aiName : (ent.display_name ?? aiName ?? "");

  // Step C: structured extraction.
  const profile = await extractStructuredProfile(env, pages);
  if (!profile) {
    // Persist zero-confidence note per architectural constraint.
    await insertFact(env, {
      entity_id: entityId, predicate: "ai_profile_filler_failed",
      value_text: "structured_extraction_invalid_json",
      source_kind: "ai", source: PROFILE_FILLER_VERSION, evidence_url: homepage.url, confidence: 0,
    });
    await stampCooldown(env, entityId);
    return { ok: false, entityId, reason: "extraction_failed", pages_fetched: pages.length, name_corrected };
  }

  // Step D (light): coerce + sanity-check.
  if (profile.headquarters_country_iso2 && !/^[A-Za-z]{2}$/.test(profile.headquarters_country_iso2)) {
    profile.headquarters_country_iso2 = undefined;
  }
  if (profile.contact_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.contact_email)) {
    profile.contact_email = undefined;
  }

  // Step E: write to DB.
  const written = await writeProfileToDb(env, entityId, profile, homepage.url);

  // Step F: search corroboration (best-effort, only if we have a name).
  let corroborated = 0;
  if (canonicalName) {
    corroborated = await corroborateClaims(env, entityId, canonicalName, profile, homepage.url);
  }
  void corroborated;

  // Stamp freshness via fact + cooldown.
  await insertFact(env, {
    entity_id: entityId, predicate: "ai_profile_filled_at",
    value_text: new Date().toISOString(),
    value_json: { triggered_by: opts.triggeredBy ?? "manual", force: !!opts.force, pages: pages.length },
    source_kind: "ai", source: PROFILE_FILLER_VERSION, evidence_url: homepage.url, confidence: 1,
  });
  await stampCooldown(env, entityId);

  return {
    ok: true,
    entityId,
    facts_written: written.facts_written,
    team_added: written.team_added,
    portfolio_added: written.portfolio_added,
    pages_fetched: pages.length,
    name_corrected,
  };
}

// ---- Batch helper used by the nightly cron / batch workflow ------------

export async function pickStalestEntities(env: Env, limit: number): Promise<string[]> {
  // Stalest = entities that have never been profile-filled (no
  // `ai_profile_filled_at` fact) OR whose last fill is oldest. Joins
  // u_entities ↔ facts on the most-recent filled marker.
  const rows = await env.DB.prepare(
    `SELECT u.id,
            (SELECT MAX(observed_at) FROM facts f
              WHERE f.entity_id = u.id AND f.predicate = 'ai_profile_filled_at') AS last_filled
       FROM u_entities u
      WHERE u.status = 'active'
        AND (u.primary_url IS NOT NULL OR u.primary_domain IS NOT NULL)
      ORDER BY (last_filled IS NULL) DESC, last_filled ASC
      LIMIT ?`,
  ).bind(limit).all<{ id: string; last_filled: string | null }>();
  return (rows.results ?? []).map((r) => r.id);
}

export async function fillStalestBatch(env: Env, opts?: { limit?: number }): Promise<{ scanned: number; filled: number; errors: number; skipped: number }> {
  const limit = opts?.limit ?? 200;
  const ids = await pickStalestEntities(env, limit);
  let filled = 0, errors = 0, skipped = 0;
  for (const id of ids) {
    try {
      const r = await fillProfile(env, id, { triggeredBy: "cron:nightly" });
      if (r.ok) filled += 1; else skipped += 1;
    } catch (e) {
      errors += 1;
      console.warn("fillProfile batch fail", id, (e as Error).message);
    }
  }
  return { scanned: ids.length, filled, errors, skipped };
}
