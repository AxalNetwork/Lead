import type { Env, JobMessage, ParsedLead } from "../types";
import { fetchPage, fetchBytes } from "./fetcher";
import { selectParser } from "./parsers";
import { parsePdf } from "./parsers/pdf";
import { extractDomain } from "./normalize";
import { discoverUrls } from "./fallbacks/sitemap";
import { tosBlockedReason } from "./tos";
import { discoverPartnersForFirm, discoverByPersona } from "../discovery/discover";
import { saveCandidates } from "../discovery/store";
import { selectImporter, FIRMLIST_IMPORTERS } from "./parsers/firmlists";
import { upsertFirm } from "./firms_upsert";
import { recordRunResult, stampEntitiesSeen } from "../sources/registry";
import { getLegacyEntityId } from "../entities/roles";
import { canonicalEmail, canonicalLinkedin } from "../entities/normalize";
import { addTag } from "../entities/tags";
import { insertFact } from "../entities/facts";
import type { Taxonomy } from "../entities/model";
import { withEntityLock } from "../do/EntityLock";
import { buildSeedUrls, type FetchedPage } from "./firmcrawl/pathProbes";
import { extractPeopleFromPage, nameKeyOf, type ExtractedPerson } from "./firmcrawl/personExtract";
import { aiExtractPeople } from "../ai/extract";
import { guessEmails } from "./firmcrawl/emailGuess";
import { enqueueLinkedinDiscovery, enqueueCrunchbaseUrl } from "./firmcrawl/profileFollow";
import { dispatchProfile } from "./parsers/profile";
import { classifyPage, isNewsLike } from "../services/pageClassifier";
import { ingestNewsPage } from "../news/page_ingest";
import { inferAndAssignRoles } from "../services/roleInference";

/**
 * Filter helper used by every enqueue site so ToS-blocked domains never even
 * get a job row. The fetcher also refuses these at request time as a second
 * line of defence.
 */
function isEnqueueable(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return tosBlockedReason(host) === null;
  } catch {
    return false;
  }
}
import { LeadsRepo } from "../db/leads.repo";
import type { Lead } from "../db/leads.types";
import { buildCanonicalKeys, recordReview, resolveIncoming } from "../dedupe";
import type { IncomingLead } from "../dedupe/merge";
import { checkAndScrubDnc } from "../compliance/dnc";
import { deriveSlugs } from "../tax/tag";

const RAW_HTML_PREFIX = "raw";

async function sha256(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function isCancelled(env: Env, jobId: string): Promise<boolean> {
  // Task #2: also short-circuit when the budget sweeper has marked the
  // row `timed_out`. Without this, an in-flight queue message would keep
  // executing past the budget even though the job is officially dead.
  const r = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
  return r?.status === "cancelled" || r?.status === "timed_out";
}

async function markRunning(env: Env, jobId: string): Promise<void> {
  // Task #2: stamp `running_started_at` unconditionally on the
  // queued->running transition so the budget clock measures actual
  // running time, not enqueue time. Legacy `started_at` (NOT NULL,
  // used by many list queries) is left alone. The migration-193
  // state-machine trigger still gates the status transition itself.
  //
  // Defensive: if migration 214 hasn't applied yet (column missing),
  // ALTER it in-place once and retry. Avoids `D1_ERROR: no such
  // column: running_started_at` flooding the error log during the
  // deploy window when the queue is draining stale messages.
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "UPDATE jobs SET status = 'running', running_started_at = ? WHERE id = ? AND status = 'queued'",
    ).bind(now, jobId).run();
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.includes("no such column: running_started_at")) {
      try { await env.DB.exec("ALTER TABLE jobs ADD COLUMN running_started_at TEXT"); } catch { /* race: another worker added it */ }
      await env.DB.prepare(
        "UPDATE jobs SET status = 'running', running_started_at = ? WHERE id = ? AND status = 'queued'",
      ).bind(now, jobId).run();
    } else {
      throw e;
    }
  }
}

async function markFailed(env: Env, jobId: string, error: string, costMs: number): Promise<void> {
  // Task #2: never overwrite a terminal state set by the sweeper or
  // operator (timed_out / cancelled / dead_letter). The status filter
  // here is what guarantees that a worker that finally throws after
  // having been swept stays terminal under its true cause.
  await env.DB.prepare(
    `UPDATE jobs SET status = 'failed', error = ?, finished_at = ?,
            cost_ms = COALESCE(cost_ms,0) + ?
       WHERE id = ? AND status IN ('queued','running')`,
  )
    .bind(error.slice(0, 1000), new Date().toISOString(), costMs, jobId)
    .run();
}

async function markCompleted(
  env: Env,
  jobId: string,
  leadsFound: number,
  pagesFetched: number,
  pagesBlocked: number,
  captchaHits: number,
  costMs: number,
  result: Record<string, unknown>,
): Promise<void> {
  await env.DB.prepare(
    `UPDATE jobs SET status = 'succeeded', finished_at = ?, leads_found = ?, pages_fetched = ?, pages_blocked = ?, captcha_hits = ?, cost_ms = COALESCE(cost_ms,0) + ?, result_json = ? WHERE id = ?`,
  )
    .bind(
      new Date().toISOString(),
      leadsFound,
      pagesFetched,
      pagesBlocked,
      captchaHits,
      costMs,
      JSON.stringify(result),
      jobId,
    )
    .run();
}

async function archiveRawHtml(env: Env, url: string, html: string): Promise<string | null> {
  if (!html) return null;
  try {
    const hash = await sha256(url);
    const date = new Date().toISOString().slice(0, 10);
    const key = `${RAW_HTML_PREFIX}/${hash}/${date}.html`;
    await env.RAW_HTML.put(key, html, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
    return key;
  } catch (e) {
    console.warn("R2 archive failed", (e as Error).message);
    return null;
  }
}

function leadToIncoming(lead: ParsedLead, parserName: string): IncomingLead {
  const meta = lead.meta ?? {};
  const socials = (meta.socials as Array<{ platform: string; url: string }> | undefined) ?? [];
  const linkedin = socials.find((s) => s.platform === "linkedin")?.url ?? null;
  const twitter = socials.find((s) => s.platform === "twitter")?.url ?? null;
  const github = socials.find((s) => s.platform === "github")?.url ?? null;
  return {
    email: lead.email ?? null,
    phone: null,
    linkedin_url: linkedin,
    twitter_url: twitter,
    github_url: github,
    personal_url: null,
    name: lead.name ?? null,
    org: lead.org ?? null,
    title: lead.title ?? null,
    category: lead.category ?? null,
    bio: null,
    country_iso2: null,
    region: null,
    city: null,
    timezone: null,
    source_domain: lead.source_domain,
    source_url: lead.source_url,
    alt_emails: [],
    tags: [],
    provider: parserName,
  };
}

/**
 * Insert a fresh lead row using the dedupe-aware path. If the incoming lead
 * matches an existing row above the auto-merge threshold, this becomes an
 * UPDATE on the existing row (with audit history) and returns null. If the
 * match is borderline, the row is inserted with status='needs_review' and a
 * dedupe_review row is created. Otherwise a normal new row is inserted.
 *
 * Returns the id of the row that should be counted as "leads_found", or null
 * if the incoming evidence merged into an existing row instead.
 */
export async function insertLead(
  env: Env,
  parsed: ParsedLead,
  parserName: string,
  jobId: string,
  fetchedFrom: "live" | "wayback" = "live",
  /**
   * Task #1: when an importer (e.g. Folk) needs facts written with a
   * dedicated provenance label (`source='folk_share'`,
   * `source_kind='import'`) instead of the default scrape provenance.
   * Threaded down to `LeadsRepo.insert` → `syncLeadToEntity` →
   * `insertFactsBatch`.
   */
  importCtx: { source?: string; sourceKind?: "scrape" | "import" | "manual" | "enrichment" | "ai" | "inferred" } | null = null,
): Promise<string | null> {
  const incoming = leadToIncoming(parsed, parserName);

  // ---- Compliance pre-insert hook: scrub DNC-listed PII, flag the lead. ----
  const dnc = await checkAndScrubDnc(env, {
    email: incoming.email ?? null,
    phone: incoming.phone ?? null,
    linkedin_url: incoming.linkedin_url ?? null,
    twitter_url: incoming.twitter_url ?? null,
    github_url: incoming.github_url ?? null,
    source_domain: parsed.source_domain ?? null,
  });
  if (dnc.hit) {
    incoming.email = dnc.cleaned.email;
    incoming.phone = dnc.cleaned.phone;
    incoming.linkedin_url = dnc.cleaned.linkedin_url;
    incoming.twitter_url = dnc.cleaned.twitter_url;
    incoming.github_url = dnc.cleaned.github_url;
  }

  const decision = await resolveIncoming(env.DB, incoming, { jobId, provider: parserName, dncHit: dnc.hit }, env);

  if (decision.action === "merged") {
    return null;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const meta = JSON.stringify({ ...(parsed.meta ?? {}), job_id: jobId, fetched_from: fetchedFrom });
  const status = decision.action === "needs_review" ? "needs_review" : "new";
  const keys = buildCanonicalKeys({
    email: incoming.email,
    phone: incoming.phone,
    linkedin_url: incoming.linkedin_url,
    name: incoming.name,
    org: incoming.org,
    city: incoming.city,
  });

  const lead: Lead = {
    id,
    name: incoming.name ?? null,
    email: incoming.email ?? null,
    phone: incoming.phone ?? null,
    org: incoming.org ?? null,
    title: incoming.title ?? null,
    category: incoming.category ?? null,
    source_domain: parsed.source_domain,
    source_url: parsed.source_url,
    status,
    verified: 0,
    flagged: 0,
    approved_at: null,
    approved_by: null,
    linkedin_url: incoming.linkedin_url ?? null,
    twitter_url: incoming.twitter_url ?? null,
    github_url: incoming.github_url ?? null,
    personal_url: incoming.personal_url ?? null,
    alt_emails_json: null,
    bio: null,
    country_iso2: null,
    region: null,
    city: null,
    timezone: null,
    tags_json: null,
    provider: parserName,
    canonical_email_key: keys.canonical_email_key ?? null,
    canonical_phone_key: keys.canonical_phone_key ?? null,
    canonical_linkedin_key: keys.canonical_linkedin_key ?? null,
    canonical_name_firm_key: keys.canonical_name_firm_key ?? null,
    canonical_name_city_key: keys.canonical_name_city_key ?? null,
    merged_into: null,
    meta_json: meta,
    created_at: now,
    updated_at: now,
  };

  // Tag with taxonomy slugs at insert time (no extra DB roundtrip needed).
  const slugs = deriveSlugs({
    category: lead.category,
    sector_focus_json: lead.sector_focus_json ?? null,
    city: lead.city ?? null,
    region: lead.region ?? null,
    country_iso2: lead.country_iso2 ?? null,
  });
  if (slugs.sectorSlug) (lead as unknown as Record<string, unknown>).sector_slug = slugs.sectorSlug;
  if (slugs.geoSlug) (lead as unknown as Record<string, unknown>).geo_slug = slugs.geoSlug;
  if (slugs.country_iso2 && !lead.country_iso2) lead.country_iso2 = slugs.country_iso2;
  if (dnc.hit) (lead as unknown as Record<string, unknown>).do_not_contact = 1;

  const repo = new LeadsRepo(env.DB, env);
  await repo.insert(lead, importCtx ?? undefined);

  if (decision.action === "needs_review") {
    await recordReview(env.DB, decision.candidate.id, id, decision.score, decision.reasons);
  }

  const entityId = await getLegacyEntityId(env, "leads", id);
  if (entityId) {
    const kind = String(parsed.category ?? incoming.category ?? "").toLowerCase();
    const title = String(incoming.title ?? parsed.title ?? "");
    await inferAndAssignRoles(env, entityId, {
      kind: "person",
      sourceKind: importCtx?.sourceKind ?? "scrape",
      sourceUrl: parsed.source_url ?? incoming.source_url ?? null,
      sourceDomain: parsed.source_domain ?? null,
      title,
      org: incoming.org ?? null,
      category: kind,
      importLabel: parserName,
    });
  }

  return id;
}
