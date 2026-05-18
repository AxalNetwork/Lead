// Task #5: Profile types registry service. Single source of truth for
// the ~80 profile types persisted in `e_types`. The router,
// seed-discovery, and per-type enrichment workflows read the registry
// through this module rather than re-querying D1 directly.

import type { Env } from "../../types";

export interface DetectionSignals {
  url_patterns: string[];
  title_keywords: string[];
  content_keywords: string[];
  evidence_required: string[];
}

export interface SeedSources {
  urls: string[];
  search_queries: string[];
}

export interface ProfileType {
  id: string;
  label: string;
  category: string;
  entity_kind: "person" | "company";
  parent_type_id: string | null;
  detection_signals: DetectionSignals;
  enrichment_predicates: string[];
  seed_sources: SeedSources;
  icon: string | null;
  color: string | null;
}

export const CATEGORIES = [
  "capital","legal","financial","operator","advisory","talent","press",
  "policy","technical","academic","company","service_firm","public_sector",
] as const;
export type Category = typeof CATEGORIES[number];

const KV_KEY = "profile_types:registry:v1";
const KV_TTL_S = 300; // 5 minute KV cache

interface CachedRegistry { fetchedAt: number; types: ProfileType[] }
let memCache: CachedRegistry | null = null;
const MEM_TTL_MS = 60_000;

function safeJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch { return fallback; }
}

function normalizeDetection(d: unknown): DetectionSignals {
  const obj = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
  const asArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((s) => typeof s === "string") as string[] : [];
  return {
    url_patterns: asArr(obj.url_patterns),
    title_keywords: asArr(obj.title_keywords),
    content_keywords: asArr(obj.content_keywords),
    evidence_required: asArr(obj.evidence_required),
  };
}

function normalizeSeed(d: unknown): SeedSources {
  const obj = (d && typeof d === "object" ? d : {}) as Record<string, unknown>;
  const asArr = (v: unknown): string[] => Array.isArray(v) ? v.filter((s) => typeof s === "string") as string[] : [];
  return { urls: asArr(obj.urls), search_queries: asArr(obj.search_queries) };
}

function rowToType(r: {
  id: string; label: string; category: string; entity_kind: string;
  parent_type_id: string | null; detection_signals_json: string;
  enrichment_predicates_json: string; seed_sources_json: string;
  icon: string | null; color: string | null;
}): ProfileType {
  return {
    id: r.id,
    label: r.label,
    category: r.category,
    entity_kind: (r.entity_kind === "person" ? "person" : "company"),
    parent_type_id: r.parent_type_id,
    detection_signals: normalizeDetection(safeJson(r.detection_signals_json, {})),
    enrichment_predicates: safeJson<string[]>(r.enrichment_predicates_json, []).filter((s) => typeof s === "string"),
    seed_sources: normalizeSeed(safeJson(r.seed_sources_json, {})),
    icon: r.icon,
    color: r.color,
  };
}

// loadRegistry returns the full ~80-type list. Cached in memory for 60s
// and in KV for 5 minutes to keep the GET /api/profile-types endpoint
// cheap (it is read by the router on every classify call).
export async function loadRegistry(env: Env): Promise<ProfileType[]> {
  const now = Date.now();
  if (memCache && now - memCache.fetchedAt < MEM_TTL_MS) return memCache.types;

  if (env.SCRAPE_CACHE) {
    try {
      const raw = await env.SCRAPE_CACHE.get(KV_KEY);
      if (raw) {
        const types = JSON.parse(raw) as ProfileType[];
        memCache = { fetchedAt: now, types };
        return types;
      }
    } catch (e) { console.warn("profileTypes KV read failed", (e as Error).message); }
  }

  const r = await env.DB.prepare(
    `SELECT id, label, category, entity_kind, parent_type_id,
            detection_signals_json, enrichment_predicates_json,
            seed_sources_json, icon, color
       FROM e_types
       ORDER BY category, id`,
  ).all<Parameters<typeof rowToType>[0]>();
  const types = (r.results ?? []).map(rowToType);
  memCache = { fetchedAt: now, types };
  if (env.SCRAPE_CACHE) {
    try { await env.SCRAPE_CACHE.put(KV_KEY, JSON.stringify(types), { expirationTtl: KV_TTL_S }); }
    catch (e) { console.warn("profileTypes KV write failed", (e as Error).message); }
  }
  return types;
}

export async function getType(env: Env, id: string): Promise<ProfileType | null> {
  const all = await loadRegistry(env);
  return all.find((t) => t.id === id) ?? null;
}

// Convenience wrapper matching the signature called out in task spec
// (`testPage(typeId, {url, html})`). The route handler uses the lower-
// level `testPage(type, page)` form so it can return 404 separately
// when the type id is unknown.
export async function testPageById(
  env: Env,
  typeId: string,
  page: { url?: string; html?: string },
): Promise<TestPageResult | null> {
  const t = await getType(env, typeId);
  if (!t) return null;
  return testPage(t, page);
}

export function invalidateRegistry(env?: Env): void {
  memCache = null;
  if (env?.SCRAPE_CACHE) {
    try { void env.SCRAPE_CACHE.delete(KV_KEY); } catch {}
  }
}

export interface TestPageResult {
  matched: boolean;
  fired_signals: string[];
  unmet_evidence: string[];
  confidence: number;
}

// Heuristic phrases for evidence predicate keys. `evidence_required`
// in the registry uses predicate IDs (e.g. `bar_state`, `jd_school`)
// so the same vocabulary is consumed by enrichment workflows. When
// checking a raw page, we look for any of these natural-language
// phrases that typically appear alongside the predicate.
const EVIDENCE_PHRASES: Record<string, string[]> = {
  bar_state: ["bar admission", "admitted to the bar", "state bar", "bar of "],
  law_firm_employer: ["llp", "law firm", " p.c.", " pllc"],
  jd_school: ["j.d.", "jd,", "juris doctor", "law school"],
  llm_tax: ["ll.m.", "llm "],
  uspto_reg: ["uspto", "u.s. patent office", "registered patent"],
  fund_aum: ["aum", "assets under management", "fund size"],
  portfolio_size: ["portfolio companies", "portfolio company"],
  portfolio_count: ["portfolio companies", "investments"],
  angel_portfolio_count: ["angel investments", "portfolio of"],
  corporate_parent: ["a subsidiary of", "wholly owned", "parent company"],
  family_principal: ["family office", "principal of"],
  institution_name: ["university", "endowment", "foundation"],
  country_name: ["republic of", "kingdom of", "ministry of"],
  plan_name: ["pension", "retirement system"],
  fund_count_committed: ["fund commitments", "limited partner in"],
  program_duration_weeks: ["weeks", "month program", "cohort"],
  program_type: ["incubator", "residency"],
  studio_model: ["studio", "build companies"],
  syndicate_lead: ["lead investor", "syndicate lead"],
  secondary_strategy: ["secondary", "tender offer"],
  firm_employer: ["partner at", "associate at", "joined "],
  scouting_firm: ["scout for", "scout program"],
  host_firm: ["entrepreneur in residence", "eir at"],
  companies_advised: ["advisor to", "advisory board"],
  bank_employer: ["goldman", "morgan", "citi", "jp morgan", "managing director", "vice president"],
  finra_crd: ["finra", "crd #"],
  companies_worked: ["previously at", "vp at", "head of", "led"],
  cfo_experience: ["cfo", "chief financial"],
  cto_experience: ["cto", "chief technology"],
  coo_experience: ["coo", "chief operating"],
  cmo_experience: ["cmo", "chief marketing"],
  search_firm: ["executive search", "korn ferry", "spencer stuart", "heidrick"],
  board_seats: ["board of directors", "board member", "director at"],
  office_held: ["senator", "representative", "mayor", "council", "elected"],
  state: [" state of ", " state, "],
  city: [" city of ", " mayor of "],
  principal_employer: ["chief of staff", "advisor to"],
  company_founded: ["founded", "founder of", "co-founded"],
  prior_companies: ["previously founded", "founder of", "second-time founder"],
  co_founders: ["along with", "co-founded with", "with co-founder"],
  technical_background: ["software engineer", "computer science", "engineering background"],
  business_background: ["mba", "consultant", "investment banking"],
  company_joined: ["joined", "founding team", "employee #"],
  prior_exits: ["acquired by", "sold to", "exit"],
  bank_name: ["bank", "banking"],
  fund_name: ["fund", "capital"],
  firm_name: ["llp", "llc", "firm"],
  company_name: ["inc", "ltd", "corporation"],
  exchange_name: ["exchange", "nyse", "nasdaq"],
  ticker: ["nyse:", "nasdaq:", "ticker"],
  funding_stage: ["seed", "series a", "series b", "raised $"],
  valuation: ["valuation", "valued at"],
  employee_count: ["employees", "people", "team of"],
  parent_investor: ["backed by", "portfolio company of"],
  icp_signals: ["enterprise", "smb", "small business", "consumer"],
  acquisition_history: ["acquired", "acquisition of"],
  publication: ["staff writer at", "reporter at", "contributor", "byline"],
  podcast_name: ["podcast"],
  newsletter_name: ["newsletter", "substack"],
  channel_url: ["youtube.com", "subscribe"],
  public_works: ["author of", "speaker at", "ted talk"],
  event_name: ["conference", "summit"],
  university: ["university", "college", "institute of technology"],
  advisor: ["advisor", "supervisor"],
  employer: ["scientist at", "researcher at"],
  lab_name: ["lab", "laboratory"],
  institution: ["university", "institute"],
  agency_name: ["department of", "agency", "administration"],
  org_name: ["organization", "foundation", "institute"],
};

function evidenceTokenMatches(token: string, text: string, url: string): boolean {
  const t = token.trim();
  if (!t) return true;
  const lc = t.toLowerCase();
  // Exact literal substring (covers natural-language phrases).
  if (text.includes(lc) || url.includes(lc)) return true;
  // Predicate-key fallback: look for any of the heuristic phrases.
  const phrases = EVIDENCE_PHRASES[lc];
  if (phrases && phrases.some((p) => text.includes(p) || url.includes(p))) return true;
  return false;
}

// Deterministic detection. No LLM. Each fired signal contributes to
// confidence; evidence requirements are evaluated against the same
// page text (an "OR" clause is satisfied if any token matches). Evidence
// gates degrade confidence rather than hard-failing the match, so a
// page with multiple fired signals but unmet predicate evidence still
// matches with a lower confidence — callers may apply their own
// thresholds.
export function testPage(type: ProfileType, page: { url?: string; html?: string }): TestPageResult {
  const url = String(page.url ?? "").toLowerCase();
  const html = String(page.html ?? "");
  const lowerHtml = html.toLowerCase();
  // Strip tags for a cleaner text scan; keep <title> separately.
  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = (titleMatch ? titleMatch[1] : "").toLowerCase();
  const text = lowerHtml.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  const fired: string[] = [];
  let signalCount = 0;

  for (const pat of type.detection_signals.url_patterns) {
    signalCount++;
    if (pat && url.includes(pat.toLowerCase())) fired.push(`url_pattern:${pat}`);
  }
  for (const kw of type.detection_signals.title_keywords) {
    signalCount++;
    if (kw && title.includes(kw.toLowerCase())) fired.push(`title_keyword:${kw}`);
  }
  for (const kw of type.detection_signals.content_keywords) {
    signalCount++;
    if (kw && text.includes(kw.toLowerCase())) fired.push(`content_keyword:${kw}`);
  }

  const unmetEvidence: string[] = [];
  for (const ev of type.detection_signals.evidence_required) {
    const parts = ev.split(/\s+OR\s+/i).map((s) => s.trim()).filter(Boolean);
    const ok = parts.some((p) => evidenceTokenMatches(p, text, url));
    if (!ok) unmetEvidence.push(ev);
  }

  const signalScore = signalCount > 0 ? fired.length / signalCount : 0;
  const evidencePenalty = type.detection_signals.evidence_required.length > 0
    ? unmetEvidence.length / type.detection_signals.evidence_required.length
    : 0;
  const confidence = Math.max(0, Math.min(1, signalScore * (1 - 0.4 * evidencePenalty)));
  // Match on signal strength + confidence floor; evidence degrades but
  // doesn't veto. Two fired signals with confidence ≥ 0.2 is enough to
  // call it a positive match for downstream consumers.
  const matched = fired.length >= 2 && confidence >= 0.2;
  return { matched, fired_signals: fired, unmet_evidence: unmetEvidence, confidence: Number(confidence.toFixed(3)) };
}
