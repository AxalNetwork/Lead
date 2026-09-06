// Task #9: Garbage Entity Detector & Cleanup.
//
// Pure detector (`isGarbage`) flags HTML page titles / nav fragments /
// UI strings polluting `u_entities`. Used by:
//   * The pre-insert guard in `createEntity` (rejects before write).
//   * The cron sweep (`runCleanupSweep`) that soft-deletes recently-
//     created garbage and, on `mode='all'`, performs the one-off pass.
//   * The /ops/garbage-review/ console (admin restore / purge).
//
// HONEST DEGRADATION (Task #14 pattern): the optional Workers AI second
// opinion (`aiSecondOpinion`) returns `uncertain` when the `env.AI`
// binding is absent, on any HTTP/network error, or when the JSON
// response is malformed. `evaluateEntity` then DOES NOT flag the
// entity — never silently garbage.

import type { Env } from "../types";
import type { EntityKind, EntityRole } from "./model";

export interface GarbageInput {
  kind: EntityKind | string;
  display_name?: string | null;
  primary_url?: string | null;
  primary_domain?: string | null;
  primary_email_key?: string | null;
  primary_linkedin_key?: string | null;
}

export interface GarbageVerdict {
  is_garbage: boolean;
  reasons: string[];
}

const NAME_MAX_LEN = 80;

// Curated UI / nav strings observed in production on the Investors page.
// Lowercased for comparison.
const KNOWN_UI_STRINGS = new Set([
  "contact us", "contact", "search icon", "search", "home", "about",
  "about us", "menu", "login", "log in", "sign in", "sign up",
  "sign-up", "register", "our team", "team", "limited partners",
  "portfolio", "our portfolio", "careers", "jobs", "privacy",
  "privacy policy", "terms", "terms of service", "cookies",
  "cookie policy", "blog", "news", "press", "press releases",
  "get in touch", "subscribe", "newsletter", "footer", "header",
  "navigation", "nav", "skip to content", "back to top", "read more",
  "learn more", "view all", "see all", "all rights reserved",
  "follow us", "share", "tweet", "facebook", "twitter", "linkedin",
  "instagram", "youtube", "the team", "our story",
]);

// Heuristic leaders that strongly indicate a press/blog post title
// got captured as an "entity".
const LEADER_RE =
  /^(introducing|announcing|welcome to|how|why|what|when|where|the future of|inside)\s+/i;

// Page-title with `|`-separated domain/brand fragment. Examples:
// "Our Team | Sequoia Capital", "Contact Tenity | Get in Touch",
// "Home | Sequoia Capital".
const PIPE_TITLE_RE = /\s\|\s\S/;

// Pure emoji / icon names (no alphanumerics at all).
const NO_ALNUM_RE = /^[^\p{L}\p{N}]+$/u;

// Listicle / directory page titles captured as entity names.
//
// This is the gap that let ~128 non-firms into the firms table: a crawler
// ingested aggregator pages ("VC Firms By Stage" on failory.com) and made
// one entity per outbound link, taking the page title as the name. The
// existing rules could not catch it — such a title has no pipe fragment, no
// press leader, is well under 80 characters and is not a known nav string.
//
// Deliberately narrow, because a single matched reason marks an entity
// garbage. Each pattern is a phrase a real firm name essentially never
// contains: "Top Tier Capital Partners" and "Stage Fund" are real firms, so
// a bare leading "top" or the word "stage" alone must NOT match.
const LISTICLE_RES: RegExp[] = [
  // "VC Firms By Stage", "Investors by sector", "Funds per geography"
  /\b(?:by|per)\s+(?:stage|sector|industry|geograph|countr|region|check\s*size|vertical)/i,
  // "Top 50 VC Firms", "Best 10 Seed Funds" — the number is what makes this
  // safe; a leading "Top"/"Best" alone is a legitimate name fragment.
  /^(?:the\s+)?(?:top|best|leading)\s+\d+\b/i,
  // "List of European VCs", "Directory of angel investors"
  /\b(?:list|directory|database|roundup|ranking)\s+of\s+/i,
  // "The Ultimate Guide to Seed Funds", "Complete List of ..."
  /^(?:the\s+)?(?:complete|ultimate|definitive)\s+(?:list|guide|directory|database)\b/i,
];

// Minimum length before a name that is identical to its own domain slug is
// treated as URL-derived rather than a genuine single-word brand.
// "Stripe" / "Coatue" / "Atomico" are real names that equal their domain;
// "Firstmarkcap" (firstmarkcap.com) and "Forerunnerventures" are slugs that
// were title-cased because no real name was ever extracted.
const SLUG_NAME_MIN_LEN = 12;

/**
 * True when the display name is just the registrable domain label with the
 * first letter capitalised — i.e. the crawler never found a name and fell
 * back to the URL. Length-gated so short single-word brands are untouched.
 */
function looksDomainDerived(name: string, domain: string | null | undefined): boolean {
  if (!domain) return false;
  const label = domain.toLowerCase().replace(/^www\./, "").split(".")[0] ?? "";
  if (label.length < SLUG_NAME_MIN_LEN) return false;
  const n = name.trim().toLowerCase();
  // A genuine name carries separators the slug cannot ("First Mark Capital").
  if (/[\s.\-_]/.test(n)) return false;
  return n === label;
}

// ---------------------------------------------------------------------------
// Task #6: person-name disambiguation. Classifies a name that was recorded
// as a `person` into one of: a real person, an organization scraped as a
// person (firm / fund / accelerator / company), generic page junk, or
// uncertain. Used by:
//   * the pre-insert reclassify-on-write guard in `createEntity`,
//   * the cron / one-off sweep (`runCleanupSweep`),
//   * the scraper extraction boundary (`extractPeopleFromPage`).
// PURE — name-only, no IO — so it's safe on the hot write path.
// ---------------------------------------------------------------------------

// Legal-entity suffixes — an extremely strong organization signal anywhere
// in the name. Normalized (punctuation stripped) before comparison.
const ORG_LEGAL_SUFFIX = new Set([
  "llc", "inc", "ltd", "limited", "lp", "llp", "plc", "gmbh", "ag",
  "sarl", "bv", "pty", "oy", "ab", "srl", "spa",
]);

// Descriptor words that, as the LAST token, denote an organization
// ("Intel Capital", "Mendoza Ventures", "Hillman Accelerator Foundation").
const ORG_SUFFIX_LAST = new Set([
  "capital", "ventures", "venture", "partners", "partner", "holdings",
  "group", "fund", "funds", "foundation", "labs", "lab", "hub",
  "collective", "management", "advisors", "associates", "accelerator",
  "incubator", "equity", "securities", "technologies", "studios", "studio",
  "network", "institute", "academy", "council", "alliance", "syndicate",
  "consortium", "enterprises", "industries", "international", "global",
  "company", "corp", "corporation", "university", "college", "systems",
  "solutions",
]);

// Generic, non-distinctive words. A name made up ENTIRELY of these is junk
// ("Deep Tech", "Our Mission"); they're also excluded when looking for a
// distinctive proper-noun token in an org name.
const GENERIC_WORDS = new Set([
  "the", "our", "your", "my", "a", "an", "all", "more", "new", "updated",
  "featured", "latest", "recent", "top", "best", "of", "and", "or", "for",
  "with", "to", "in", "on", "at", "by", "from", "about", "welcome", "hello",
  "home", "homepage", "page", "web", "website", "webpage", "mission",
  "vision", "values", "story", "team", "careers", "jobs", "blog", "news",
  "press", "media", "map", "menu", "footer", "header", "sidebar", "gallery",
  "resources", "events", "podcast", "newsletter", "insights", "research",
  "report", "reports", "overview", "summary", "services", "solutions",
  "products", "pricing", "features", "get", "started", "learn", "read",
  "view", "see", "guide", "guides", "faq", "faqs", "help", "support",
  "contact", "deep", "tech", "technology", "startup", "startups",
  "mentorship", "money", "data", "signal", "community", "ecosystem",
  "platform", "world", "global", "international", "region", "regions",
  "area", "areas", "north", "south", "east", "west", "central", "america",
  "americas", "europe", "asia", "africa", "oceania", "antarctica", "middle",
  "image", "images", "photo", "photos", "logo", "logos", "icon", "banner",
  "thumbnail", "placeholder", "avatar", "headshot", "slideshow", "carousel",
  "machine", "wayback", "future", "work", "working", "people", "portfolio",
  "companies", "investors", "founders", "funding", "rounds", "deals",
]);

// Words whose presence alone marks a name as page junk rather than a
// person — decorative / UI / asset captions that pass NAME_RE.
const HARD_JUNK_WORDS = new Set([
  "image", "images", "photo", "photos", "logo", "logos", "icon", "banner",
  "thumbnail", "placeholder", "gallery", "slideshow", "carousel", "homepage",
  "webpage", "sidebar", "footer", "header", "menu", "map", "wayback",
  "machine",
]);

// Exact lowercase phrases observed polluting the People list.
const KNOWN_JUNK_PHRASES = new Set([
  "updated homepage image", "our mission", "map of the money",
  "wayback machine", "deep tech", "startup mentorship hub", "read more",
  "learn more", "our team", "the team", "our story", "our values",
  "our vision", "get started", "coming soon", "page not found",
]);

// Exact lowercase place / region names that get scraped as "people".
const PLACE_NAMES = new Set([
  "north america", "south america", "central america", "latin america",
  "united states", "united kingdom", "middle east", "european union",
  "north", "south", "east", "west", "europe", "asia", "africa", "oceania",
  "antarctica", "americas", "global", "worldwide",
]);

function normToken(t: string): string {
  return t.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "");
}

function orgRoleForTokens(tokensLower: string[]): EntityRole {
  const set = new Set(tokensLower);
  if (set.has("accelerator") || set.has("incubator")) return "accelerator";
  if (set.has("fund") || set.has("funds")) return "fund";
  for (const t of ["capital", "ventures", "venture", "partners", "partner",
    "equity", "management", "advisors", "associates", "holdings",
    "securities", "syndicate"]) {
    if (set.has(t)) return "investor_firm";
  }
  return "firm";
}

/** Map an inferred org role to the `firms.kind` taxonomy for dual-write. */
export function orgRoleToFirmKind(role: EntityRole): string | null {
  switch (role) {
    case "accelerator": return "accelerator";
    case "fund": return "fund";
    case "investor_firm": return "vc";
    default: return null;
  }
}

export type PersonNameVerdict = "person" | "organization" | "junk" | "uncertain";

export interface PersonNameClassification {
  verdict: PersonNameVerdict;
  reasons: string[];
  orgRole?: EntityRole;
}

/**
 * Pure classifier for a name recorded as a `person`. Conservative by
 * design: only returns `organization` / `junk` when the signal is clear,
 * otherwise `person` (a plausible human name) or `uncertain`. Callers
 * decide what to DO with each verdict (reclassify, soft-delete, review).
 */
export function classifyPersonName(rawName: string | null | undefined): PersonNameClassification {
  const raw = (rawName ?? "").trim();
  if (!raw) return { verdict: "junk", reasons: ["empty_name"] };
  const lower = raw.toLowerCase();
  const tokens = raw.split(/\s+/).filter(Boolean);
  const norm = tokens.map(normToken).filter(Boolean);

  // 1. Exact known-junk phrase / place name.
  if (KNOWN_JUNK_PHRASES.has(lower)) return { verdict: "junk", reasons: ["known_junk_phrase"] };
  if (PLACE_NAMES.has(lower)) return { verdict: "junk", reasons: ["place_name"] };

  // 2. Hard junk word present (image / logo / homepage / map / ...).
  // PRECISION GUARD (precision-over-recall): a single junk token inside an
  // otherwise-clean two-token Title-Case name ("John Banner", "John Map")
  // must NOT auto-delete a plausible real person. Real decorative captions
  // are ≥3 tokens ("Updated Homepage Image") or all-generic two-token
  // phrases ("Wayback Machine", caught by rule 4 below), so deferring the
  // junk-word rule for clean two-token names keeps every junk fixture while
  // protecting people whose surname happens to collide with an asset word.
  const cleanTwoToken =
    tokens.length === 2 && tokens.every((t) => /^[\p{Lu}][\p{L}'’.\-]*$/u.test(t));
  if (!cleanTwoToken) {
    for (const t of norm) {
      if (HARD_JUNK_WORDS.has(t)) return { verdict: "junk", reasons: [`junk_word:${t}`] };
    }
  }

  // 3. Organization-suffix detection.
  const last = norm[norm.length - 1] ?? "";
  const hasLegal = norm.some((t) => ORG_LEGAL_SUFFIX.has(t));
  const lastIsOrgSuffix = ORG_SUFFIX_LAST.has(last);
  if (hasLegal || lastIsOrgSuffix) {
    // Need a distinctive (non-generic, non-suffix) token to call it a real
    // org. "Intel Capital" → distinctive "intel". "Startup Mentorship Hub"
    // → all-generic + suffix → junk.
    const distinctive = norm.filter((t, i) =>
      !GENERIC_WORDS.has(t) &&
      !ORG_SUFFIX_LAST.has(t) &&
      !ORG_LEGAL_SUFFIX.has(t) &&
      !(i === norm.length - 1 && lastIsOrgSuffix),
    );
    if (distinctive.length === 0) {
      return { verdict: "junk", reasons: ["generic_org_phrase"] };
    }
    return {
      verdict: "organization",
      orgRole: orgRoleForTokens(norm),
      reasons: [hasLegal ? "org_legal_suffix" : `org_suffix:${last}`],
    };
  }

  // 4. Every token is a generic word ("Deep Tech", "Our Mission").
  if (norm.length >= 1 && norm.every((t) => GENERIC_WORDS.has(t))) {
    return { verdict: "junk", reasons: ["all_generic_words"] };
  }

  // 5. Plausible human name: 2–4 tokens, ≥2 capitalized, not all generic.
  const titleTokens = tokens.filter((t) => /^[\p{Lu}]/u.test(t));
  if (tokens.length >= 2 && tokens.length <= 4 && titleTokens.length >= 2) {
    return { verdict: "person", reasons: ["plausible_person_name"] };
  }

  // 6. Anything else — don't guess.
  return { verdict: "uncertain", reasons: ["unclassified"] };
}

/** Pure detector. NO IO. Safe to call inline on every entity write. */
export function isGarbage(input: GarbageInput): GarbageVerdict {
  const reasons: string[] = [];
  const raw = (input.display_name ?? "").trim();

  // Rule 1: empty or whitespace-only name.
  if (!raw) {
    reasons.push("empty_name");
    return { is_garbage: true, reasons };
  }

  // Rule 2: name longer than 80 chars.
  if (raw.length > NAME_MAX_LEN) reasons.push("name_too_long");

  // Rule 3: pure emoji / icon (no letters or digits).
  if (NO_ALNUM_RE.test(raw)) reasons.push("no_alphanumeric_chars");

  // Rule 4: page-title with `|` brand fragment.
  if (PIPE_TITLE_RE.test(raw)) reasons.push("page_title_pipe_fragment");

  // Rule 5: blog/press leader phrase.
  if (LEADER_RE.test(raw)) reasons.push("press_leader_phrase");

  // Rule 6: known UI / nav string (case-insensitive exact match).
  if (KNOWN_UI_STRINGS.has(raw.toLowerCase())) reasons.push("known_ui_string");

  // Rule 6c: listicle / directory page title captured as an entity name.
  if (LISTICLE_RES.some((re) => re.test(raw))) reasons.push("listicle_page_title");

  // Rule 6d: name is just the domain slug — the crawler never extracted a
  // real name and fell back to the URL.
  if (looksDomainDerived(raw, input.primary_domain)) reasons.push("domain_slug_name");

  // Rule 6b (Task #6 Section A/F): literal HTML entity in name
  // (e.g. "Founder &amp; Partner", "Acme &#38; Co"). These are parser
  // bugs upstream — the entity should have been decoded before write.
  // We flag them here as garbage so they soft-delete on the next sweep
  // and surface to the operator console; the durable fix is at the
  // scraper layer via decodeEntities() (Task #6 Section F).
  if (/&(amp|lt|gt|quot|#x?[0-9a-f]+);/i.test(raw)) reasons.push("literal_html_entity");

  // Rule 7: person-specific constraints — must contain a space AND
  // must not contain pipe / slash / colon. Real human display names
  // are "First Last", not "Contact | Sequoia" or "team/people:1".
  if (input.kind === "person") {
    if (!/\s/.test(raw)) reasons.push("person_no_space");
    if (/[|/:]/.test(raw)) reasons.push("person_contains_separator");
    // Task #6: generic page-junk names recorded as people ("Updated
    // Homepage Image", "Our Mission", "North America"). Organization
    // names are NOT flagged here — they're reclassified (not deleted)
    // by the createEntity write guard and the sweep.
    const cls = classifyPersonName(raw);
    if (cls.verdict === "junk") {
      for (const code of cls.reasons) reasons.push(`name_${code}`);
    }
  }

  return { is_garbage: reasons.length > 0, reasons };
}

// ---------------------------------------------------------------------------
// Structural rule (requires DB lookups): zero facts AND zero relationships
// AND zero contact channels AND crawler-created >24h ago. Used by the
// cron sweep — NOT by the pre-insert guard (the entity hasn't been
// written yet, so it has no joins).
// ---------------------------------------------------------------------------
export async function isStructurallyOrphan(
  env: Env,
  entityId: string,
  options: { minAgeHours?: number } = {},
): Promise<{ orphan: boolean; reasons: string[] }> {
  const minAge = options.minAgeHours ?? 24;
  const reasons: string[] = [];
  try {
    const row = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM facts            WHERE entity_id = ?1) AS facts,
         (SELECT COUNT(*) FROM rel_edges        WHERE src_entity_id = ?1 OR dst_entity_id = ?1) AS rels,
         (SELECT COUNT(*) FROM channels  WHERE entity_id = ?1) AS chans,
         (SELECT (julianday('now') - julianday(created_at)) * 24 FROM u_entities WHERE id = ?1) AS age_hours`,
    ).bind(entityId).first<{ facts: number; rels: number; chans: number; age_hours: number | null }>();
    if (!row) return { orphan: false, reasons };
    const ageHours = Number(row.age_hours ?? 0);
    if (Number(row.facts) === 0 && Number(row.rels) === 0 && Number(row.chans) === 0 && ageHours >= minAge) {
      reasons.push("structural_orphan_no_signal");
      return { orphan: true, reasons };
    }
  } catch (e) {
    // Optional source tables (channels) may be missing in test
    // DBs — degrade to "not orphan" rather than throwing. Per the
    // Task #14 honest-degradation pattern.
    console.warn("isStructurallyOrphan probe failed", entityId, (e as Error).message);
  }
  return { orphan: false, reasons };
}

// ---------------------------------------------------------------------------
// Optional AI second opinion for ambiguous mid-length names.
// ---------------------------------------------------------------------------
export interface AiVerdict {
  verdict: "garbage" | "real" | "uncertain";
  confidence: number;
  reason?: string;
}

const AI_PROMPT = `You are a data-quality filter for a CRM. Given a candidate \
entity record, decide whether the display_name is a real person/organization \
name or noise scraped from an HTML page (page titles, nav labels, "Contact Us", \
press headlines like "Introducing X", marketing blurbs, etc.).
Reply ONLY as compact JSON: {"verdict":"garbage|real|uncertain","confidence":0.0-1.0,"reason":"<short>"}.`;

export async function aiSecondOpinion(env: Env, input: GarbageInput): Promise<AiVerdict> {
  if (!env.AI || typeof env.AI.run !== "function") {
    return { verdict: "uncertain", confidence: 0, reason: "ai_binding_missing" };
  }
  const payload = {
    kind: input.kind,
    display_name: input.display_name ?? null,
    primary_url: input.primary_url ?? null,
    primary_domain: input.primary_domain ?? null,
  };
  try {
    const res = (await env.AI.run("@cf/meta/llama-3.1-8b-instruct-fast", {
      messages: [
        { role: "system", content: AI_PROMPT },
        { role: "user", content: JSON.stringify(payload) },
      ],
      max_tokens: 80,
    })) as { response?: string } | string;
    const text = typeof res === "string" ? res : (res?.response ?? "");
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return { verdict: "uncertain", confidence: 0, reason: "ai_no_json" };
    const parsed = JSON.parse(match[0]) as Partial<AiVerdict>;
    const verdict = parsed.verdict === "garbage" || parsed.verdict === "real" ? parsed.verdict : "uncertain";
    const conf = typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0;
    return { verdict, confidence: conf, reason: typeof parsed.reason === "string" ? parsed.reason : undefined };
  } catch (e) {
    return { verdict: "uncertain", confidence: 0, reason: "ai_error:" + (e as Error).message };
  }
}

/**
 * Combined verdict: heuristic detector + optional AI second opinion
 * for names 30–60 chars that don't match any heuristic. AI flags only
 * when verdict='garbage' AND confidence > 0.8. When AI is unavailable
 * or returns 'uncertain', the entity is NOT flagged.
 */
export async function evaluateEntity(
  env: Env,
  input: GarbageInput,
  opts: { skipAi?: boolean } = {},
): Promise<GarbageVerdict> {
  const heur = isGarbage(input);
  if (heur.is_garbage) return heur;
  if (opts.skipAi) return heur;
  const name = (input.display_name ?? "").trim();
  if (name.length < 30 || name.length > 60) return heur;
  const ai = await aiSecondOpinion(env, input);
  if (ai.verdict === "garbage" && ai.confidence > 0.8) {
    return { is_garbage: true, reasons: ["ai_second_opinion", `ai_conf:${ai.confidence.toFixed(2)}`] };
  }
  return heur;
}

// ---------------------------------------------------------------------------
// Soft-delete / restore / purge helpers. All write through
// `data_quality_log` so the operator console can audit every transition.
// ---------------------------------------------------------------------------
export async function logDataQuality(
  env: Env,
  entityId: string,
  issue: string,
  reasons: string[],
  source: string,
  actorEmail?: string | null,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO data_quality_log (entity_id, issue, reasons_json, source, actor_email)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(entityId, issue, JSON.stringify(reasons), source, actorEmail ?? null).run();
  } catch (e) {
    console.warn("data_quality_log insert failed", entityId, (e as Error).message);
  }
}

export async function softDeleteEntity(
  env: Env,
  entityId: string,
  reasons: string[],
  source: string,
  actorEmail?: string | null,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE u_entities
        SET status = 'soft_deleted',
            deleted_reason = COALESCE(deleted_reason, ?),
            updated_at = datetime('now')
      WHERE id = ? AND status != 'soft_deleted'`,
  ).bind("garbage_detector_v1:" + reasons.join(","), entityId).run();
  try {
    await env.DB.prepare(`DELETE FROM entity_roles WHERE entity_id = ?`).bind(entityId).run();
  } catch (e) {
    console.warn("entity_roles delete during soft-delete failed", entityId, (e as Error).message);
  }
  await logDataQuality(env, entityId, "soft_deleted", reasons, source, actorEmail);
}

export async function restoreEntity(env: Env, entityId: string, actorEmail: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE u_entities
        SET status = 'active',
            deleted_reason = NULL,
            updated_at = datetime('now')
      WHERE id = ?`,
  ).bind(entityId).run();
  await logDataQuality(env, entityId, "restored", [], "operator", actorEmail);
}

export async function purgeEntity(env: Env, entityId: string, actorEmail: string): Promise<void> {
  // Best-effort cascade across the optional referencing tables; each
  // wrapped in its own try/catch so a missing table doesn't block the
  // primary delete. Per the Task #14 honest-degradation pattern.
  const cascades = [
    `DELETE FROM facts WHERE entity_id = ?`,
    `DELETE FROM rel_edges WHERE src_entity_id = ? OR dst_entity_id = ?`,
    `DELETE FROM channels WHERE entity_id = ?`,
    `DELETE FROM entity_roles WHERE entity_id = ?`,
    `DELETE FROM entity_history WHERE entity_id = ?`,
    `DELETE FROM entity_legacy_map WHERE entity_id = ?`,
  ];
  for (const sql of cascades) {
    try {
      if (sql.includes("OR dst_entity_id")) {
        await env.DB.prepare(sql).bind(entityId, entityId).run();
      } else {
        await env.DB.prepare(sql).bind(entityId).run();
      }
    } catch (e) {
      // table-missing or FK noise — log and continue
      console.warn("purge cascade failed", sql.slice(0, 40), (e as Error).message);
    }
  }
  // Log BEFORE the final delete so the audit trail survives even if
  // the row-delete races a concurrent reader. data_quality_log keeps
  // entity_id as TEXT (no FK), so the row remains queryable.
  await logDataQuality(env, entityId, "purged", [], "operator", actorEmail);
  await env.DB.prepare(`DELETE FROM u_entities WHERE id = ?`).bind(entityId).run();
}

// ---------------------------------------------------------------------------
// Task #6: reclassify a person row that is actually an organization. The
// row is FLIPPED in place (kind person→org) so it leaves the People list
// and joins the org world — non-destructive and reversible (the row, its
// facts and relationships are preserved). When a domain/website is known
// we dual-write a `firms` row so it also surfaces in the Firms list;
// upsertFirm's syncFirmToEntity re-resolves the firm to THIS now-org
// entity via the primary_domain match, so no duplicate entity is minted.
// HONEST DEGRADATION: with no domain/website we cannot dedupe a firm row
// (name-only matching mints duplicates), so we skip it and record the gap
// rather than guessing — the entity still leaves People as an org.
// ---------------------------------------------------------------------------
export async function reclassifyPersonAsOrg(
  env: Env,
  entity: {
    id: string;
    display_name: string | null;
    primary_url: string | null;
    primary_domain: string | null;
  },
  orgRole: EntityRole,
  reasons: string[],
  source: string,
  actorEmail?: string | null,
): Promise<{ reclassified: boolean; firm_listed: boolean }> {
  // 1. Flip kind in place — removes it from the People list immediately.
  await env.DB.prepare(
    `UPDATE u_entities SET kind = 'org', updated_at = datetime('now') WHERE id = ?`,
  ).bind(entity.id).run();

  // 2. Swap person/investor roles for the inferred org role. Capture the
  // prior role set into the audit trail FIRST so the reclassification is
  // fully reversible: an operator (or a rollback) can restore the original
  // roles from the data_quality_log row, not just flip the kind back.
  let priorRoles: string[] = [];
  try {
    const existing = await env.DB.prepare(
      `SELECT role FROM entity_roles WHERE entity_id = ?`,
    ).bind(entity.id).all<{ role: string }>();
    priorRoles = (existing.results ?? []).map((x) => x.role);
    await env.DB.prepare(`DELETE FROM entity_roles WHERE entity_id = ?`).bind(entity.id).run();
    await env.DB.prepare(
      `INSERT INTO entity_roles (entity_id, role, is_primary, source, confidence)
       VALUES (?, ?, 1, ?, 1)
       ON CONFLICT(entity_id, role) DO UPDATE SET is_primary = 1`,
    ).bind(entity.id, orgRole, source).run();
  } catch (e) {
    console.warn("reclassify role swap failed", entity.id, (e as Error).message);
  }

  // 3. Dual-write a firms row when we can dedupe by domain/website.
  let firmListed = false;
  if (entity.display_name && (entity.primary_domain || entity.primary_url)) {
    try {
      const { upsertFirm } = await import("../scraper/firms_upsert.js");
      await upsertFirm(env, {
        name: entity.display_name,
        domain: entity.primary_domain ?? null,
        website: entity.primary_url ?? null,
        kind: orgRoleToFirmKind(orgRole),
      }, source);
      firmListed = true;
    } catch (e) {
      console.warn("reclassify upsertFirm failed", entity.id, (e as Error).message);
    }
  }

  await logDataQuality(
    env, entity.id, "reclassified",
    [...reasons, `org_role:${orgRole}`,
     priorRoles.length ? `prior_roles:${priorRoles.join(",")}` : "prior_roles:none",
     firmListed ? "firm_listed" : "firm_row_skipped_no_domain"],
    source, actorEmail,
  );
  return { reclassified: true, firm_listed: firmListed };
}

// ---------------------------------------------------------------------------
// Sweep. Two modes:
//   * mode='recent': entities created in the last `lookbackHours` (cron path)
//   * mode='all':    full scan (one-off cleanup; admin-triggered)
// Both bounded at `limit` (default 5000) per the spec.
// ---------------------------------------------------------------------------
export interface SweepResult {
  scanned: number;
  flagged: number;
  soft_deleted: number;
  reclassified: number;
  needs_review: number;
  by_reason: Record<string, number>;
  bounded: boolean;
}

export async function runCleanupSweep(
  env: Env,
  opts: {
    mode?: "recent" | "all";
    lookbackHours?: number;
    limit?: number;
    source?: string;
    actorEmail?: string | null;
    skipAi?: boolean;
  } = {},
): Promise<SweepResult> {
  const mode = opts.mode ?? "recent";
  const lookback = opts.lookbackHours ?? 24;
  const limit = opts.limit ?? 5000;
  const source = opts.source ?? (mode === "all" ? "oneoff_cleanup" : "cron_sweep");

  const where = mode === "all"
    ? `status NOT IN ('soft_deleted','merged')`
    : `status NOT IN ('soft_deleted','merged') AND created_at >= datetime('now', '-${lookback} hours')`;

  const rows = await env.DB.prepare(
    `SELECT id, kind, display_name, primary_url, primary_domain, primary_email_key, primary_linkedin_key
       FROM u_entities
      WHERE ${where}
      ORDER BY created_at DESC
      LIMIT ?`,
  ).bind(limit).all<{
    id: string; kind: string; display_name: string | null;
    primary_url: string | null; primary_domain: string | null;
    primary_email_key: string | null; primary_linkedin_key: string | null;
  }>();

  const items = rows.results ?? [];
  const byReason: Record<string, number> = {};
  let flagged = 0;
  let softDeleted = 0;
  let reclassified = 0;
  let needsReview = 0;

  for (const r of items) {
    // Task #6: organization-name disambiguation for `person` rows.
    // Orgs scraped as people are RECLASSIFIED into the org world (and the
    // Firms list) rather than soft-deleted. A strong personal identifier
    // (personal LinkedIn /in/ or an email) contradicting an org-suffix
    // name is flagged for operator review instead of auto-flipped — never
    // destroy a likely real person. Junk / plausible-person / uncertain
    // names fall through to the existing garbage + orphan path below so
    // no prior behavior regresses.
    if (r.kind === "person") {
      const cls = classifyPersonName(r.display_name);
      if (cls.verdict === "organization" && cls.orgRole) {
        const personalLinkedin = !!r.primary_linkedin_key && /(^|\/)in\//i.test(r.primary_linkedin_key);
        const hasEmail = !!r.primary_email_key;
        if (personalLinkedin || hasEmail) {
          for (const code of cls.reasons) byReason[`review_${code}`] = (byReason[`review_${code}`] ?? 0) + 1;
          await logDataQuality(
            env, r.id, "needs_review",
            [...cls.reasons, "org_name_with_person_signal"], source, opts.actorEmail ?? null,
          );
          needsReview += 1;
          continue;
        }
        try {
          await reclassifyPersonAsOrg(
            env,
            { id: r.id, display_name: r.display_name, primary_url: r.primary_url, primary_domain: r.primary_domain },
            cls.orgRole, cls.reasons, source, opts.actorEmail ?? null,
          );
          reclassified += 1;
          byReason[`reclassified_${cls.orgRole}`] = (byReason[`reclassified_${cls.orgRole}`] ?? 0) + 1;
        } catch (e) {
          console.warn("sweep reclassify failed", r.id, (e as Error).message);
        }
        continue;
      }
    }

    // Route through evaluateEntity so the AI second opinion fires for
    // ambiguous 30–60 char names (when env.AI is bound). Honors
    // skipAi for unit tests + operator-requested fast sweeps.
    const evald = await evaluateEntity(env, {
      kind: r.kind, display_name: r.display_name,
      primary_url: r.primary_url, primary_domain: r.primary_domain,
      primary_email_key: r.primary_email_key, primary_linkedin_key: r.primary_linkedin_key,
    }, { skipAi: opts.skipAi });
    let reasons = evald.reasons;
    let flag = evald.is_garbage;
    if (!flag) {
      // Structural rule — only meaningful when the entity is not
      // brand-new (otherwise the crawler may still be writing joins).
      const orphan = await isStructurallyOrphan(env, r.id, { minAgeHours: 24 });
      if (orphan.orphan) { flag = true; reasons = orphan.reasons; }
    }
    if (!flag) continue;
    flagged += 1;
    for (const code of reasons) byReason[code] = (byReason[code] ?? 0) + 1;
    try {
      await softDeleteEntity(env, r.id, reasons, source, opts.actorEmail ?? null);
      softDeleted += 1;
    } catch (e) {
      console.warn("sweep soft-delete failed", r.id, (e as Error).message);
    }
  }

  const result: SweepResult = {
    scanned: items.length, flagged, soft_deleted: softDeleted,
    reclassified, needs_review: needsReview,
    by_reason: byReason, bounded: items.length >= limit,
  };
  console.log("garbage.cleanup_sweep", JSON.stringify({ mode, ...result }));
  return result;
}
