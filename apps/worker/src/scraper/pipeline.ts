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
  const r = await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(jobId).first<{ status: string }>();
  return r?.status === "cancelled";
}

async function markRunning(env: Env, jobId: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'running', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'queued'",
  )
    .bind(new Date().toISOString(), jobId)
    .run();
}

async function markFailed(env: Env, jobId: string, error: string, costMs: number): Promise<void> {
  await env.DB.prepare(
    "UPDATE jobs SET status = 'failed', error = ?, finished_at = ?, cost_ms = COALESCE(cost_ms,0) + ? WHERE id = ?",
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
async function insertLead(
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
  return id;
}

async function touchSource(env: Env, url: string): Promise<boolean> {
  const domain = extractDomain(url);
  if (!domain) return false;
  const existing = await env.DB.prepare("SELECT id FROM sources WHERE domain = ?").bind(domain).first<{ id: string }>();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sources (id, domain, kind, enabled, last_scraped_at, created_at)
     VALUES (?, ?, 'auto', 1, ?, ?)
     ON CONFLICT(domain) DO UPDATE SET last_scraped_at = excluded.last_scraped_at`,
  )
    .bind(crypto.randomUUID(), domain, now, now)
    .run();
  return !existing;
}

/**
 * On the first time we see a `source_domain`, mine the sitemap and likely
 * team/about/people URLs and enqueue them as child jobs. Bounded so we never
 * fan out beyond a handful of pages per new domain.
 */
async function seedDomainDiscovery(env: Env, parentJobId: string, seedUrl: string): Promise<void> {
  const { guessed, fromSitemap, fromFeed } = await discoverUrls(seedUrl);
  const candidates = [...guessed, ...fromSitemap, ...fromFeed].slice(0, 16);
  if (!candidates.length) return;
  const now = new Date().toISOString();
  for (const childUrl of candidates) {
    if (childUrl === seedUrl) continue;
    if (!isEnqueueable(childUrl)) continue;
    const childId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
       VALUES (?, ?, ?, 'queued', 'url', ?, ?, ?, ?)`,
    )
      .bind(childId, `discovery:${childUrl}`, extractDomain(childUrl), childUrl, JSON.stringify({ parent: parentJobId, discovery: true }), now, now)
      .run();
    await env.LEAD_QUEUE.send({ jobId: childId, kind: "url", target: childUrl });
  }
}

// ----------------------------------------------------------------------------
// Task #18: profile-aware URL dispatcher. Owns its own fetching strategy for
// LinkedIn (no fetch — search snippet only), Twitter (Nitter mirror), GitHub
// (REST API), NFX (gated source — reject), Crunchbase person (__NEXT_DATA__),
// Crunchbase organization (→ FirmCandidate), and personal site (Task #17
// 8-strategy extractor + /about /contact /now probes).
//
// Fanout depth is tracked on the job's config_json. The first url-job is
// `depth=0`; outbound socials/personal links it surfaces are enqueued as
// `depth=1` children. We refuse to enqueue when `depth >= 1` so a single
// profile cannot trigger an unbounded crawl.
// ----------------------------------------------------------------------------

const PROFILE_FANOUT_MAX_DEPTH = 1;

async function fanoutProfileUrls(
  env: Env,
  parentJobId: string,
  parentUrl: string,
  outbound: string[],
  parentDepth: number,
): Promise<number> {
  if (parentDepth >= PROFILE_FANOUT_MAX_DEPTH) return 0;
  let enqueued = 0;
  const seen = new Set<string>([parentUrl.toLowerCase()]);
  for (const childUrl of outbound) {
    const norm = childUrl.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    if (!isEnqueueable(childUrl)) continue;
    const childId = crypto.randomUUID();
    const now = new Date().toISOString();
    const cfg = JSON.stringify({ parent: parentJobId, depth: parentDepth + 1 });
    await env.DB.prepare(
      `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
       VALUES (?, ?, ?, 'queued', 'url', ?, ?, ?, ?)`,
    ).bind(childId, `profile_fanout:${childUrl}`, extractDomain(childUrl), childUrl, cfg, now, now).run();
    await env.LEAD_QUEUE.send({
      jobId: childId, kind: "url", target: childUrl,
      config: { parent: parentJobId, depth: parentDepth + 1 },
    });
    enqueued += 1;
  }
  return enqueued;
}

async function processProfileUrl(
  env: Env,
  jobId: string,
  url: string,
  config?: Record<string, unknown>,
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number }> {
  if (await isCancelled(env, jobId)) {
    return { leadsFound: 0, pagesFetched: 0, pagesBlocked: 0, captchaHits: 0, costMs: 0 };
  }
  const depth = Number((config?.depth as number | string | undefined) ?? 0) || 0;

  const dispatch = await dispatchProfile(env, url, jobId);

  // Archive the actually-fetched HTML when applicable. Personal-site
  // dispatch may have followed `/about` `/contact` `/now` probes — each
  // gets its own archival + sources row so the dashboard accounts for
  // every byte the worker actually pulled. LinkedIn/GitHub still touch
  // the lead's source domain so it shows up in cost roll-ups even though
  // there's no HTML to store.
  if (dispatch.fetched && dispatch.fetched.ok && dispatch.fetched.html) {
    await archiveRawHtml(env, dispatch.fetched.url || url, dispatch.fetched.html);
    await touchSource(env, dispatch.fetched.url || url);
  } else if (dispatch.kind === "linkedin" || dispatch.kind === "github") {
    await touchSource(env, url);
  }
  // Personal-site probes (`/about` `/contact` `/now`) live in
  // `dispatch.extraFetched`. Archive each + record a sources row so the
  // dashboard accounts for every page the worker actually pulled.
  for (const extra of dispatch.extraFetched ?? []) {
    if (extra.result.ok && extra.result.html) {
      await archiveRawHtml(env, extra.result.url || extra.url, extra.result.html);
      await touchSource(env, extra.result.url || extra.url);
    }
  }

  // Crunchbase organization → upsert into `firms` instead of `leads`.
  // We deliberately do NOT swallow upsertFirm errors: a Crunchbase-org URL
  // exists for the sole purpose of producing a firm row, so an upsert
  // failure means the job did not achieve its purpose and should fail
  // loudly rather than report a misleading "0 leads, success".
  let firmsCreated = 0;
  if (dispatch.firmCandidate) {
    const r = await upsertFirm(env, dispatch.firmCandidate, "profile/crunchbase-org");
    if (r.action === "created" || r.action === "updated") firmsCreated += 1;
  }

  let leadsFound = 0;
  for (const lead of dispatch.leads) {
    if (await isCancelled(env, jobId)) break;
    // Per-lead provenance: personal probes pass `_fetched_from` via meta so
    // a live `/about` lead is not mislabeled `wayback` because the primary
    // page came from the archive (or vice versa). Strip the hint before
    // inserting so it doesn't leak into the persisted meta_json.
    const metaHint = lead.meta as { _fetched_from?: "live" | "wayback" } | undefined;
    const perLeadFrom = metaHint?._fetched_from;
    const fallbackFrom: "live" | "wayback" =
      dispatch.fetched && dispatch.fetched.fetched_from === "wayback" ? "wayback" : "live";
    const fetchedFrom = perLeadFrom ?? fallbackFrom;
    if (lead.meta && "_fetched_from" in lead.meta) delete (lead.meta as Record<string, unknown>)._fetched_from;
    const id = await insertLead(env, lead, `profile/${dispatch.kind}`, jobId, fetchedFrom);
    if (id) leadsFound += 1;
  }

  // Depth-1 fanout: enqueue any outbound socials/personal links. The cap
  // is enforced inside fanoutProfileUrls.
  let fanoutEnqueued = 0;
  if (dispatch.outboundUrls.length > 0) {
    try {
      fanoutEnqueued = await fanoutProfileUrls(env, jobId, url, dispatch.outboundUrls, depth);
    } catch (e) {
      console.warn("profile fanout failed", (e as Error).message);
    }
  }

  // Stash a small per-job summary so /api/jobs/:id renders something useful.
  await env.DB.prepare(
    `INSERT INTO fetch_log (job_id, host, url, tier, status, bytes, block_reason, duration_ms, cost_usd, created_at)
     VALUES (?, ?, ?, 0, 200, 0, ?, ?, 0, ?)`,
  ).bind(
    jobId, safeHost(url), url,
    JSON.stringify({
      profile_kind: dispatch.kind,
      depth,
      leads: leadsFound,
      firms_created: firmsCreated,
      outbound_total: dispatch.outboundUrls.length,
      fanout_enqueued: fanoutEnqueued,
    }),
    dispatch.costMs,
    new Date().toISOString(),
  ).run();

  return {
    leadsFound: leadsFound + firmsCreated,
    pagesFetched: dispatch.pagesFetched,
    pagesBlocked: dispatch.pagesBlocked,
    captchaHits: dispatch.captchaHits,
    costMs: dispatch.costMs,
  };
}

async function processSingleUrl(
  env: Env,
  jobId: string,
  url: string,
  config?: Record<string, unknown>,
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number }> {
  let leadsFound = 0;
  let pagesFetched = 0;
  let pagesBlocked = 0;
  let captchaHits = 0;
  let costMs = 0;

  if (await isCancelled(env, jobId)) return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };

  // Task #18: profile-aware dispatcher. PDFs always take the bytes path
  // below; everything else routes through `selectParser` and, when the
  // parser registry returns "profile", through the URL-aware async
  // dispatcher (which handles LinkedIn snippets without fetching, Twitter
  // → Nitter rewrite, GitHub REST API, NFX rejection, Crunchbase org →
  // firm upsert, and personal-site multi-page probing).
  const looksLikePdfEarly = /\.pdf(\?|#|$)/i.test(url);
  if (!looksLikePdfEarly && selectParser(url).name === "profile") {
    return processProfileUrl(env, jobId, url, config);
  }

  // PDF path: sniff by URL extension first (cheap). For URLs without a `.pdf`
  // suffix we still fall through to fetchPage; if the fetched body starts with
  // the PDF magic bytes (`%PDF-`) we re-fetch as bytes and route to parsePdf.
  const looksLikePdf = /\.pdf(\?|#|$)/i.test(url);
  if (looksLikePdf) {
    const blob = await fetchBytes(env, url, { jobId });
    costMs += blob.durationMs;
    if (!blob.ok) {
      pagesBlocked += 1;
      throw new Error(`fetch_failed:${blob.blockReason ?? "unknown"}:status=${blob.status}`);
    }
    pagesFetched += 1;
    await touchSource(env, url);
    const pdfLeads = await parsePdf(blob.bytes, url);
    for (const lead of pdfLeads) {
      if (await isCancelled(env, jobId)) break;
      const id = await insertLead(env, lead, "pdf", jobId, "live");
      if (id) leadsFound += 1;
    }
    return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };
  }

  const fetched = await fetchPage(env, url, { jobId });
  costMs += fetched.durationMs;

  if (!fetched.ok) {
    pagesBlocked += 1;
    if (fetched.blockReason === "captcha") captchaHits += 1;
    throw new Error(`fetch_failed:${fetched.blockReason ?? "unknown"}:status=${fetched.status}`);
  }

  pagesFetched += 1;

  // Magic-byte sniff: some sites serve PDFs from URLs without a `.pdf` suffix.
  // The HTML fetcher returns the binary as text; if it starts with `%PDF-` we
  // re-fetch as bytes and dispatch to the PDF parser instead.
  if (fetched.html.startsWith("%PDF-")) {
    const blob = await fetchBytes(env, url, { jobId });
    if (blob.ok) {
      await touchSource(env, url);
      const pdfLeads = await parsePdf(blob.bytes, url);
      for (const lead of pdfLeads) {
        if (await isCancelled(env, jobId)) break;
        const id = await insertLead(env, lead, "pdf", jobId, fetched.fetched_from);
        if (id) leadsFound += 1;
      }
      return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs: costMs + blob.durationMs };
    }
  }

  await archiveRawHtml(env, url, fetched.html);
  const isNewDomain = await touchSource(env, url);

  const { name: parserName, parser } = selectParser(url);
  const parsed = parser(fetched.html, fetched.url);

  for (const lead of parsed) {
    if (await isCancelled(env, jobId)) break;
    const id = await insertLead(env, lead, parserName, jobId, fetched.fetched_from);
    if (id) leadsFound += 1;
  }

  if (isNewDomain && fetched.fetched_from === "live") {
    try {
      await seedDomainDiscovery(env, jobId, url);
    } catch (e) {
      console.warn("seedDomainDiscovery failed", (e as Error).message);
    }
  }

  return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };
}

async function processLinktree(
  env: Env,
  jobId: string,
  target: string,
  config: Record<string, unknown> | undefined,
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number }> {
  let leadsFound = 0;
  let pagesFetched = 0;
  let pagesBlocked = 0;
  let captchaHits = 0;
  let costMs = 0;

  if (await isCancelled(env, jobId)) return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };

  const fetched = await fetchPage(env, target, { jobId });
  costMs += fetched.durationMs;
  if (!fetched.ok) {
    pagesBlocked += 1;
    if (fetched.blockReason === "captcha") captchaHits += 1;
    throw new Error(`fetch_failed:${fetched.blockReason ?? "unknown"}`);
  }
  pagesFetched += 1;
  await archiveRawHtml(env, target, fetched.html);
  await touchSource(env, target);

  const parserName = (config?.parser as string | undefined) ?? "linktree";
  const { parser } = await import("./parsers").then((m) => ({
    parser: m.PARSERS[parserName] ?? m.PARSERS.generic,
  }));
  const parsed = parser(fetched.html, fetched.url);

  for (const lead of parsed) {
    if (await isCancelled(env, jobId)) break;
    const id = await insertLead(env, lead, parserName, jobId, fetched.fetched_from);
    if (id) leadsFound += 1;

    const outbound = Array.isArray(lead.meta?.outbound) ? (lead.meta!.outbound as string[]) : [];
    for (const childUrl of outbound.slice(0, 50)) {
      if (!isEnqueueable(childUrl)) continue;
      const childId = crypto.randomUUID();
      const now = new Date().toISOString();
      await env.DB.prepare(
        `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
         VALUES (?, ?, ?, 'queued', 'url', ?, ?, ?, ?)`,
      )
        .bind(childId, `child:${childUrl}`, extractDomain(childUrl), childUrl, JSON.stringify({ parent: jobId }), now, now)
        .run();
      await env.LEAD_QUEUE.send({ jobId: childId, kind: "url", target: childUrl });
    }
  }

  return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };
}

async function processDiscover(
  env: Env,
  jobId: string,
  target: string,
  config: Record<string, unknown> | undefined,
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number }> {
  const start = Date.now();
  const mode = (config?.mode as string | undefined) ?? "firm";
  const candidates = mode === "persona"
    ? await discoverByPersona(env, String(config?.persona ?? target), config?.country as string | undefined)
    : await discoverPartnersForFirm(env, String(config?.firmDomain ?? target));
  const inserted = await saveCandidates(env.DB, jobId, candidates);
  // Candidates are review-gated: child url-jobs are only enqueued when an
  // operator approves a row via POST /api/discover/:id/resolve.
  await env.DB
    .prepare("UPDATE jobs SET result_json = ? WHERE id = ?")
    .bind(JSON.stringify({ candidates: candidates.length, inserted }), jobId)
    .run();
  return { leadsFound: 0, pagesFetched: candidates.length, pagesBlocked: 0, captchaHits: 0, costMs: Date.now() - start };
}

/**
 * Firmlist job processor. Picks an importer (explicit hint or auto-detect),
 * runs it, upserts each returned firm, then enqueues a `firm_team_crawl`
 * child job per upserted firm so partner pages can be scraped downstream.
 */
async function processFirmlist(
  env: Env,
  jobId: string,
  target: string,
  config: Record<string, unknown> = {},
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number }> {
  const start = Date.now();
  const hint = typeof config.importer === "string" ? config.importer : null;
  const explicit = hint && Object.prototype.hasOwnProperty.call(FIRMLIST_IMPORTERS, hint)
    ? { name: hint, importer: FIRMLIST_IMPORTERS[hint] }
    : null;
  const picked = explicit ?? selectImporter(target);

  let result: import("./parsers/firmlists/types").FirmlistImportResult;
  try {
    result = await picked.importer(target, env);
  } catch (e) {
    result = { firms: [], totalSeen: 0, errors: [`importer_throw:${(e as Error).message}`] };
  }

  let created = 0;
  let updated = 0;
  let unchanged = 0;
  let peopleCreated = 0;
  let peopleMerged = 0;
  let edgesCreated = 0;
  const childJobIds: string[] = [];
  const importedFrom = `firmlist:${picked.name}`;

  // Importer-supplied per-record key (`import_key`) → unified entity_id
  // map. Used to resolve `EdgeCandidate.from_key` / `to_key` directly to
  // unified entity ids — including the merged-row case where `insertLead`
  // returned null because dedupe collapsed into an existing lead. Only
  // populated for importers that emit `import_key` (e.g. Folk).
  const firmKeyToEntity = new Map<string, string>();
  const personKeyToEntity = new Map<string, string>();

  // Task #1 acceptance: Folk-share imports must stamp every unified-graph
  // fact with `source='folk_share'` and `source_kind='import'` (not the
  // default `firmlist:folk` + `scrape`). For all other firmlist importers
  // the default scrape provenance applies. Threaded through upsertFirm /
  // insertLead → syncFirmToEntity / syncLeadToEntity → insertFactsBatch.
  const folkImportCtx: { source: string; sourceKind: "import" } | null =
    picked.name === "folk" ? { source: "folk_share", sourceKind: "import" } : null;

  for (const f of result.firms) {
    if (await isCancelled(env, jobId)) break;
    let upsertRes: { firmId: number; action: "created" | "updated" | "unchanged"; website: string | null; domain: string | null };
    try {
      upsertRes = await upsertFirm(env, f, importedFrom, folkImportCtx ?? undefined);
    } catch (e) {
      // Skip individual upsert failures — a bad row shouldn't kill the import.
      result.errors = result.errors ?? [];
      result.errors.push(`upsert_fail:${f.name}:${(e as Error).message}`);
      continue;
    }
    if (upsertRes.action === "created") created += 1;
    else if (upsertRes.action === "updated") updated += 1;
    else unchanged += 1;
    const fKey = (f as unknown as { import_key?: string }).import_key;
    if (fKey) {
      const ent = await getLegacyEntityId(env, "firms", upsertRes.firmId);
      if (ent) {
        firmKeyToEntity.set(fKey, ent);
        // Task #1: route Folk-imported firms through the EntityLock DO
        // so per-entity merges are serialized (concurrent imports of the
        // same firm from two Folk shares can't clobber each other) and
        // so the Vectorize + AI-Search indices are refreshed with the
        // freshest name/website/city for the unified record.
        if (folkImportCtx) {
          await withEntityLock(env, "firm", String(upsertRes.firmId), "merge_firm", {
            id: String(upsertRes.firmId),
            fields: {
              name: f.name,
              website: upsertRes.website ?? "",
              hq_country_iso2: f.hq_country_iso2 ?? "",
              hq_city: f.hq_city ?? "",
              thesis: f.thesis ?? "",
            },
            history_source: "folk_share",
          }).catch((e) => console.warn("folk firm EntityLock failed", upsertRes.firmId, (e as Error).message));
        }
        await tagAsFolkImport(env, ent, picked.name, f.source_url ?? target);
      }
    }

    // Enqueue child team-crawl job using the persisted firm record's
    // canonical website (or synthesize https://{domain}). This guarantees
    // we always crawl what's actually stored, even when the import row
    // lacked a website but the existing firm row had one.
    const teamUrl = pickTeamUrlFromUpsert(upsertRes) ?? pickTeamUrl(f);
    if (teamUrl && isEnqueueable(teamUrl)) {
      const childId = crypto.randomUUID();
      const now = new Date().toISOString();
      let childSource = "";
      try { childSource = new URL(teamUrl).hostname.toLowerCase(); } catch { /* leave blank */ }
      const childName = `firm_team_crawl:${f.name}`;
      // Spec contract: firm_team_crawl jobs use target=String(firmId).
      // The processor resolves the homepage from firms.website/domain.
      const childTarget = String(upsertRes.firmId);
      await env.DB.prepare(
        `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
         VALUES (?, ?, ?, 'queued', 'firm_team_crawl', ?, ?, ?, ?)`,
      ).bind(childId, childName, childSource, childTarget, JSON.stringify({ firmId: upsertRes.firmId, parentJobId: jobId, homepage_hint: teamUrl }), now, now).run();
      await env.LEAD_QUEUE.send({
        jobId: childId,
        kind: "firm_team_crawl",
        target: childTarget,
        config: { firmId: upsertRes.firmId, parentJobId: jobId, homepage_hint: teamUrl },
      });
      childJobIds.push(childId);
    }
  }

  // ---- People (Folk + future importers that emit person records) ----
  for (const p of result.people ?? []) {
    if (await isCancelled(env, jobId)) break;
    const parsedLead: ParsedLead = {
      name: p.name,
      email: p.email ?? undefined,
      org: p.org ?? undefined,
      title: p.title ?? undefined,
      category: p.category ?? undefined,
      source_domain: p.source_domain ?? safeHost(target),
      source_url: p.source_url ?? target,
      meta: {
        socials: [
          p.linkedin_url ? { platform: "linkedin", url: p.linkedin_url } : null,
          p.twitter_url ? { platform: "twitter", url: p.twitter_url } : null,
          p.github_url ? { platform: "github", url: p.github_url } : null,
        ].filter(Boolean) as Array<{ platform: string; url: string }>,
        tags: p.tags ?? [],
        bio: p.bio ?? null,
        country_iso2: p.country_iso2 ?? null,
        region: p.region ?? null,
        city: p.city ?? null,
        personal_url: p.personal_url ?? null,
      },
    };
    let leadId: string | null;
    try {
      leadId = await insertLead(env, parsedLead, importedFrom, jobId, "live", folkImportCtx ?? null);
    } catch (e) {
      result.errors = result.errors ?? [];
      result.errors.push(`person_insert_fail:${p.name}:${(e as Error).message}`);
      continue;
    }
    if (leadId) peopleCreated += 1;
    else peopleMerged += 1;
    const pKey = (p as unknown as { import_key?: string }).import_key;
    if (pKey) {
      // Resolve the person to its unified entity id. When `insertLead`
      // created a new row we can go through `entity_legacy_map`; when
      // dedupe merged the incoming evidence into an existing lead the
      // returned leadId is null, so fall back to a direct canonical-key
      // lookup against `u_entities` (mirrors `resolveOrCreate`).
      let entityId: string | null = null;
      if (leadId) entityId = await getLegacyEntityId(env, "leads", leadId);
      if (!entityId) entityId = await resolvePersonEntityId(env, p.email ?? null, p.linkedin_url ?? null);
      if (entityId) {
        personKeyToEntity.set(pKey, entityId);
        // Task #1: route Folk-imported people through the EntityLock DO
        // (mirrors the firm path above). Only fires for newly-created
        // rows — when dedupe merged the evidence into an existing lead
        // the merge already passed through EntityLock via the dedupe
        // pipeline, so re-locking here would be redundant.
        if (folkImportCtx && leadId) {
          await withEntityLock(env, "lead", leadId, "merge_lead", {
            id: leadId,
            fields: {
              name: parsedLead.name,
              email: parsedLead.email ?? "",
              source_url: parsedLead.source_url,
            },
            history_source: "folk_share",
          }).catch((e) => console.warn("folk lead EntityLock failed", leadId, (e as Error).message));
        }
        await tagAsFolkImport(env, entityId, picked.name, p.source_url ?? target, p.tags ?? null);
      }
    }
  }

  // ---- Edges: resolve import_keys to unified entity ids, then write rel_edges ----
  for (const edge of result.edges ?? []) {
    if (await isCancelled(env, jobId)) break;
    try {
      const srcEntity = personKeyToEntity.get(edge.from_key) ?? firmKeyToEntity.get(edge.from_key) ?? null;
      const dstEntity = personKeyToEntity.get(edge.to_key) ?? firmKeyToEntity.get(edge.to_key) ?? null;
      if (!srcEntity || !dstEntity) continue;
      await env.DB.prepare(
        `INSERT INTO rel_edges (id, src_entity_id, dst_entity_id, kind, source)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(src_entity_id, dst_entity_id, kind, IFNULL(valid_from,'')) DO NOTHING`,
      ).bind(crypto.randomUUID(), srcEntity, dstEntity, edge.kind, importedFrom).run();
      edgesCreated += 1;
    } catch (e) {
      result.errors = result.errors ?? [];
      result.errors.push(`edge_fail:${edge.from_key}->${edge.to_key}:${(e as Error).message}`);
    }
  }

  // Persist a per-job summary using the same fetch_log audit pattern other
  // processors use (one row scoped to this jobId).
  await env.DB.prepare(
    `INSERT INTO fetch_log (job_id, host, url, tier, status, bytes, block_reason, duration_ms, cost_usd, created_at)
     VALUES (?, ?, ?, 0, 200, 0, ?, ?, 0, ?)`,
  ).bind(
    jobId,
    safeHost(target),
    target,
    JSON.stringify({
      importer: picked.name,
      total_seen: result.totalSeen,
      created,
      updated,
      unchanged,
      people_created: peopleCreated,
      people_merged: peopleMerged,
      edges_created: edgesCreated,
      child_jobs: childJobIds.length,
      errors: (result.errors ?? []).slice(0, 20),
    }),
    Date.now() - start,
    new Date().toISOString(),
  ).run();

  return {
    // We treat each upserted firm + each fresh person as a "lead found".
    leadsFound: created + updated + peopleCreated,
    pagesFetched: 1,
    pagesBlocked: 0,
    captchaHits: 0,
    costMs: Date.now() - start,
  };
}

// ----------------------------------------------------------------------------
// Task #17: Firm team-page crawl. Loads a firm by id, builds a team-page seed
// set (sitemap + homepage anchors + curated path probes), fetches up to 8
// candidate pages, runs the 8-strategy person extractor, and writes each
// resolved person as a leads row + firm_people join. Updates firms.team_size
// and firms.last_enriched_at on completion. Persists a per-job summary
// (pages_tried, pages_parsed, people_found, emails_found) onto the job row.
// ----------------------------------------------------------------------------

const TEAM_CRAWL_PAGE_CAP = 8;

function inferPersona(role: string | null | undefined): { persona_role: string | null; seniority: string | null } {
  const t = (role || "").toLowerCase();
  if (/general partner|managing partner|founding partner/.test(t)) return { persona_role: "vc_partner", seniority: "partner" };
  if (/operating partner/.test(t)) return { persona_role: "operating_partner", seniority: "partner" };
  if (/venture partner/.test(t)) return { persona_role: "vc_partner", seniority: "partner" };
  if (/\bpartner\b/.test(t)) return { persona_role: "vc_partner", seniority: "partner" };
  if (/principal/.test(t)) return { persona_role: "vc_principal", seniority: "principal" };
  if (/associate|analyst/.test(t)) return { persona_role: "vc_analyst", seniority: "associate" };
  if (/advisor|board/.test(t)) return { persona_role: "advisor", seniority: "advisor" };
  if (/founder|chief|\bceo\b|\bcto\b|\bcfo\b|\bcmo\b|\bcoo\b/.test(t)) return { persona_role: "founder", seniority: "executive" };
  return { persona_role: null, seniority: null };
}

interface FirmRow {
  id: number;
  name: string;
  website: string | null;
  domain: string | null;
}

/**
 * Insert (or merge into) a lead and return the surviving lead id. Mirrors
 * the dedupe-aware `insertLead` path above but always returns the id of
 * the row firm_people should join to. We pass through the same DNC scrub +
 * resolveIncoming arbitration as the standard scraper insert.
 */
interface EmailEntry { email: string; verified: 0 | 1; source: string; source_url: string | null; observed_at: string }
interface SocialEntry { platform: string; url: string; source: string; source_url: string | null; observed_at: string }

function buildEmailsJson(person: ExtractedPerson, guesses: { email: string; pattern: string }[], sourceUrl: string, now: string): EmailEntry[] {
  const out: EmailEntry[] = [];
  if (person.email) {
    out.push({ email: person.email.toLowerCase(), verified: 0, source: "firm_team_page", source_url: sourceUrl, observed_at: now });
  }
  for (const g of guesses) {
    out.push({ email: g.email.toLowerCase(), verified: 0, source: "pattern_guess", source_url: sourceUrl, observed_at: now });
  }
  return out;
}

function buildSocialsJson(person: ExtractedPerson, sourceUrl: string, now: string): SocialEntry[] {
  const out: SocialEntry[] = [];
  if (person.linkedin) out.push({ platform: "linkedin", url: person.linkedin, source: "firm_team_page", source_url: sourceUrl, observed_at: now });
  if (person.twitter) out.push({ platform: "twitter", url: person.twitter, source: "firm_team_page", source_url: sourceUrl, observed_at: now });
  if (person.crunchbase) out.push({ platform: "crunchbase", url: person.crunchbase, source: "firm_team_page", source_url: sourceUrl, observed_at: now });
  if (person.personal_site) out.push({ platform: "personal", url: person.personal_site, source: "firm_team_page", source_url: sourceUrl, observed_at: now });
  return out;
}

function unionEntries<T extends { email?: string; url?: string }>(existing: string | null, additions: T[], dedupeKey: (e: T) => string): { json: string; changed: boolean } {
  const cur: T[] = (() => {
    if (!existing) return [];
    try { const v = JSON.parse(existing); return Array.isArray(v) ? v : []; } catch { return []; }
  })();
  const seen = new Set(cur.map((e) => dedupeKey(e).toLowerCase()));
  let changed = false;
  for (const a of additions) {
    const k = dedupeKey(a).toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    cur.push(a);
    changed = true;
  }
  return { json: JSON.stringify(cur), changed };
}

async function appendEmailsAndSocials(
  env: Env,
  leadId: string,
  emails: EmailEntry[],
  socials: SocialEntry[],
): Promise<void> {
  if (emails.length === 0 && socials.length === 0) return;
  const row = await env.DB
    .prepare("SELECT emails_json, socials_json FROM leads WHERE id = ?")
    .bind(leadId)
    .first<{ emails_json: string | null; socials_json: string | null }>();
  if (!row) return;
  const e = unionEntries(row.emails_json, emails, (x) => (x as EmailEntry).email);
  const s = unionEntries(row.socials_json, socials, (x) => (x as SocialEntry).url);
  if (!e.changed && !s.changed) return;
  await env.DB
    .prepare("UPDATE leads SET emails_json = ?, socials_json = ?, updated_at = ? WHERE id = ?")
    .bind(e.json, s.json, new Date().toISOString(), leadId)
    .run();
}

async function upsertCrawlLead(
  env: Env,
  jobId: string,
  person: ExtractedPerson,
  firm: FirmRow,
  sourceUrl: string,
): Promise<{ leadId: string; action: "merged" | "inserted" | "needs_review" } | null> {
  const fullName = person.name?.trim();
  if (!fullName) return null;
  const observedAt = new Date().toISOString();

  // Rerun-safety pre-check (Task #17 invariant): if this firm already has a
  // person with the same canonical name+firm key joined via firm_people,
  // bind to that lead unconditionally — independent of dedupe score. This
  // closes the case where a guessed-only contact would otherwise score
  // below AUTO_MERGE_THRESHOLD on rerun and create a fresh duplicate row.
  const nameFirmKey = buildCanonicalKeys({
    email: null,
    phone: null,
    linkedin_url: null,
    name: fullName,
    org: firm.name,
    city: null,
  }).canonical_name_firm_key;
  if (nameFirmKey) {
    const prior = await env.DB.prepare(
      `SELECT l.id AS id FROM firm_people fp
         JOIN leads l ON l.id = fp.lead_id
        WHERE fp.firm_id = ? AND l.canonical_name_firm_key = ?
        LIMIT 1`,
    ).bind(firm.id, nameFirmKey).first<{ id: string }>();
    if (prior?.id) {
      // Even on the rerun-bind path, append any newly observed emails/socials
      // to the existing lead so a partial earlier crawl can be enriched.
      const guesses = person.email ? [] : guessEmails(fullName, firm.domain);
      await appendEmailsAndSocials(
        env,
        prior.id,
        buildEmailsJson(person, guesses, sourceUrl, observedAt),
        buildSocialsJson(person, sourceUrl, observedAt),
      );
      return { leadId: prior.id, action: "merged" };
    }
  }

  // Pattern guesses are stored ONLY in the structured `emails_json` array
  // (with verified=0, source='pattern_guess'). They must NOT populate
  // `leads.email` or `alt_emails_json`, since outbound exporters
  // (campaigns/exporters.ts) read those columns and would otherwise send
  // mail to unverified guesses. Hunter verification (Task #6) flips a
  // guess to verified=1 and is responsible for promoting it into
  // leads.email at that point.
  const guesses = person.email ? [] : guessEmails(fullName, firm.domain);
  const primaryEmail = person.email ?? null;

  const incoming: IncomingLead = {
    email: primaryEmail,
    phone: null,
    linkedin_url: person.linkedin ?? null,
    twitter_url: person.twitter ?? null,
    github_url: null,
    personal_url: person.personal_site ?? null,
    name: fullName,
    org: firm.name,
    title: person.role ?? null,
    category: "investor",
    bio: person.bio ?? null,
    country_iso2: null,
    region: null,
    city: null,
    timezone: null,
    source_domain: extractDomain(sourceUrl) ?? firm.domain ?? null,
    source_url: sourceUrl,
    alt_emails: [],
    tags: ["firm_team_crawl"],
    provider: "firm_team_crawl",
  };

  const dnc = await checkAndScrubDnc(env, {
    email: incoming.email ?? null,
    phone: incoming.phone ?? null,
    linkedin_url: incoming.linkedin_url ?? null,
    twitter_url: incoming.twitter_url ?? null,
    github_url: incoming.github_url ?? null,
    source_domain: incoming.source_domain ?? null,
  });
  if (dnc.hit) {
    incoming.email = dnc.cleaned.email;
    incoming.phone = dnc.cleaned.phone;
    incoming.linkedin_url = dnc.cleaned.linkedin_url;
    incoming.twitter_url = dnc.cleaned.twitter_url;
    incoming.github_url = dnc.cleaned.github_url;
  }

  const decision = await resolveIncoming(env.DB, incoming, {
    jobId,
    provider: "firm_team_crawl",
    dncHit: dnc.hit,
  }, env);

  if (decision.action === "merged") {
    // Append structured emails/socials to the surviving lead so guessed
    // patterns and discovered socials are not lost on dedupe.
    await appendEmailsAndSocials(
      env,
      decision.into,
      buildEmailsJson(person, guesses, sourceUrl, observedAt),
      buildSocialsJson(person, sourceUrl, observedAt),
    );
    return { leadId: decision.into, action: "merged" };
  }

  // Insert path (either fresh or borderline-needs-review).
  const id = crypto.randomUUID();
  const now = observedAt;
  const persona = inferPersona(person.role ?? null);
  const emailsJson = buildEmailsJson(person, guesses, sourceUrl, now);
  const socialsJson = buildSocialsJson(person, sourceUrl, now);
  const meta = JSON.stringify({
    job_id: jobId,
    firm_id: firm.id,
    source_strategy: person.source_strategy,
    avatar_url: person.avatar ?? null,
    email_pattern_guess: !person.email && guesses.length > 0 ? guesses[0]?.pattern ?? null : null,
  });
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
    name: fullName,
    email: incoming.email ?? null,
    phone: null,
    org: firm.name,
    title: person.role ?? null,
    category: "investor",
    source_domain: incoming.source_domain ?? firm.domain ?? null,
    source_url: sourceUrl,
    status,
    verified: 0,
    flagged: 0,
    approved_at: null,
    approved_by: null,
    linkedin_url: incoming.linkedin_url ?? null,
    twitter_url: incoming.twitter_url ?? null,
    github_url: null,
    personal_url: incoming.personal_url ?? null,
    alt_emails_json: null,
    bio: person.bio ?? null,
    country_iso2: null,
    region: null,
    city: null,
    timezone: null,
    tags_json: JSON.stringify(["firm_team_crawl"]),
    provider: "firm_team_crawl",
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
  if (persona.persona_role) (lead as unknown as Record<string, unknown>).persona_role = persona.persona_role;
  if (persona.seniority) (lead as unknown as Record<string, unknown>).seniority = persona.seniority;
  if (dnc.hit) (lead as unknown as Record<string, unknown>).do_not_contact = 1;
  // Structured emails_json + socials_json (Task #17 spec). Each entry
  // carries verified/source/source_url so downstream verification can
  // mark Hunter-confirmed addresses without losing the pattern_guess
  // provenance.
  if (emailsJson.length) (lead as unknown as Record<string, unknown>).emails_json = JSON.stringify(emailsJson);
  if (socialsJson.length) (lead as unknown as Record<string, unknown>).socials_json = JSON.stringify(socialsJson);

  const repo = new LeadsRepo(env.DB, env);
  await repo.insert(lead);

  if (decision.action === "needs_review") {
    await recordReview(env.DB, decision.candidate.id, id, decision.score, decision.reasons);
  }
  return { leadId: id, action: decision.action === "needs_review" ? "needs_review" : "inserted" };
}

async function attachToFirm(
  env: Env,
  firmId: number,
  leadId: string,
  role: string | null,
  sourceUrl: string,
): Promise<void> {
  const persona = inferPersona(role);
  const isDecisionMaker = persona.seniority === "partner" || persona.seniority === "executive" ? 1 : 0;
  // ON CONFLICT IGNORE — UNIQUE(firm_id, lead_id) means rerunning a crawl
  // does not duplicate the join row.
  await env.DB.prepare(
    `INSERT INTO firm_people (firm_id, lead_id, role, is_decision_maker, source_url)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(firm_id, lead_id) DO UPDATE SET
       role = COALESCE(firm_people.role, excluded.role),
       source_url = COALESCE(firm_people.source_url, excluded.source_url)`,
  ).bind(firmId, leadId, role, isDecisionMaker, sourceUrl).run();
}

async function loadFirm(env: Env, firmId: number): Promise<FirmRow | null> {
  return env.DB
    .prepare("SELECT id, name, website, domain FROM firms WHERE id = ?")
    .bind(firmId)
    .first<FirmRow>();
}

async function processFirmTeamCrawl(
  env: Env,
  jobId: string,
  target: string,
  config: Record<string, unknown> | undefined,
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number; result: Record<string, unknown> }> {
  const start = Date.now();
  let leadsFound = 0;
  let pagesBlocked = 0;
  let captchaHits = 0;

  // Spec contract: target = String(firmId). Fall back to config.firmId for
  // backward compat with any legacy queued jobs.
  const targetNum = Number(target);
  const firmIdRaw = Number.isFinite(targetNum) ? targetNum : Number(config?.firmId);
  if (!Number.isFinite(firmIdRaw)) throw new Error("firm_team_crawl:missing_firm_id");
  const firmId = firmIdRaw;
  const firm = await loadFirm(env, firmId);
  if (!firm) throw new Error(`firm_team_crawl:firm_not_found:${firmId}`);

  const homepage = (() => {
    const hint = typeof config?.homepage_hint === "string" ? (config?.homepage_hint as string) : null;
    for (const cand of [firm.website, hint, firm.domain ? `https://${firm.domain}` : null]) {
      if (!cand) continue;
      try { return new URL(cand).toString(); } catch { /* try next */ }
    }
    throw new Error(`firm_team_crawl:no_homepage:${firmId}`);
  })();

  // Build the candidate seed set. buildSeedUrls actively probes the curated
  // TEAM_PATHS (Tier-0 only; 404 does not escalate) and returns up to
  // TEAM_CRAWL_PAGE_CAP pages already fetched, so we don't re-fetch here.
  const seeds = await buildSeedUrls(env, homepage, jobId, TEAM_CRAWL_PAGE_CAP);
  const fetchedPages: FetchedPage[] = seeds.pages;
  const pagesFetched = fetchedPages.length;
  // pagesBlocked = probes that didn't land in pages (404, robots, etc.)
  pagesBlocked = Math.max(0, seeds.probesSpent - pagesFetched);

  // Cross-page dedupe — we only count a person once across the full crawl.
  const peopleByKey = new Map<string, ExtractedPerson & { source_url: string }>();
  for (const pg of fetchedPages) {
    if (await isCancelled(env, jobId)) break;
    await archiveRawHtml(env, pg.url, pg.html);
    const people = extractPeopleFromPage(pg.html, pg.url, firm.domain);
    for (const p of people) {
      const k = nameKeyOf(p.name);
      if (!k) continue;
      const cur = peopleByKey.get(k);
      if (!cur) {
        peopleByKey.set(k, { ...p, source_url: pg.url });
        continue;
      }
      cur.role ??= p.role;
      cur.email ??= p.email;
      cur.linkedin ??= p.linkedin;
      cur.twitter ??= p.twitter;
      cur.crunchbase ??= p.crunchbase;
      cur.personal_site ??= p.personal_site;
      cur.avatar ??= p.avatar;
      cur.bio ??= p.bio;
    }

    // Task #25 step 2: AI second-pass on noisy SPA-rendered team pages.
    // Only fires when the deterministic extractors found <3 people on a
    // non-trivial page AND the AI binding is configured. Cached in R2 so
    // re-scrapes don't re-bill neurons.
    if (env.AI && people.length < 3 && pg.html.length > 2000) {
      try {
        const ai = await aiExtractPeople(env, pg.html, jobId);
        for (const p of ai) {
          const k = nameKeyOf(p.name);
          if (!k) continue;
          const cur = peopleByKey.get(k);
          if (!cur) {
            peopleByKey.set(k, {
              name: p.name,
              role: p.role ?? null,
              email: p.email ?? null,
              linkedin: p.linkedin ?? null,
              twitter: p.twitter ?? null,
              crunchbase: null,
              personal_site: null,
              avatar: null,
              bio: p.bio ?? null,
              source_strategy: "ai_extract",
              source_url: pg.url,
            } as ExtractedPerson & { source_url: string });
            continue;
          }
          cur.role ??= p.role ?? null;
          cur.email ??= p.email ?? null;
          cur.linkedin ??= p.linkedin ?? null;
          cur.twitter ??= p.twitter ?? null;
          cur.bio ??= p.bio ?? null;
        }
      } catch (e) {
        console.warn("aiExtractPeople second-pass failed", (e as Error).message);
      }
    }
  }

  let emailsFound = 0;
  let followLinkedin = 0;
  let followCrunchbase = 0;

  let skippedNoChannel = 0;
  for (const person of peopleByKey.values()) {
    if (await isCancelled(env, jobId)) break;
    // Acceptance criterion: every persisted person must have at least one
    // contact channel — verified email, LinkedIn, Twitter, or a successful
    // pattern-guessed email. We actually run guessEmails here so a valid
    // domain that yields zero guesses (e.g., single-token names) does NOT
    // satisfy the channel guard.
    const guessProbe = person.email ? [] : guessEmails(person.name, firm.domain);
    if (!person.email && !person.linkedin && !person.twitter && guessProbe.length === 0) {
      skippedNoChannel += 1;
      continue;
    }
    const result = await upsertCrawlLead(env, jobId, person, firm, person.source_url);
    if (!result) continue;
    leadsFound += 1;
    if (person.email) emailsFound += 1;
    await attachToFirm(env, firm.id, result.leadId, person.role ?? null, person.source_url);

    // Follow-ups — never fetch LinkedIn directly. Routes through Task #4
    // discovery (search-engine cache + registry probes).
    if (person.linkedin) {
      try {
        const id = await enqueueLinkedinDiscovery(env, jobId, person.name, firm.name, person.linkedin);
        if (id) followLinkedin += 1;
      } catch (e) {
        console.warn("enqueueLinkedinDiscovery failed", (e as Error).message);
      }
    }
    if (person.crunchbase) {
      try {
        const id = await enqueueCrunchbaseUrl(env, jobId, person.crunchbase);
        if (id) followCrunchbase += 1;
      } catch (e) {
        console.warn("enqueueCrunchbaseUrl failed", (e as Error).message);
      }
    }
  }

  // Refresh firm.team_size and last_enriched_at from ground truth.
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE firms
       SET team_size = (SELECT COUNT(*) FROM firm_people WHERE firm_id = ?),
           last_enriched_at = ?
     WHERE id = ?`,
  ).bind(firm.id, now, firm.id).run();

  // Per-job summary on the job row's result_json (and a fetch_log audit row
  // mirroring the firmlist processor's pattern).
  const summary = {
    kind: "firm_team_crawl",
    firm_id: firm.id,
    firm_name: firm.name,
    pages_tried: seeds.probesSpent,
    pages_parsed: pagesFetched,
    people_found: leadsFound,
    emails_found: emailsFound,
    skipped_no_channel: skippedNoChannel,
    follow_linkedin: followLinkedin,
    follow_crunchbase: followCrunchbase,
    seeds_probed: seeds.probesSpent,
    seeds_total: seeds.candidatesConsidered,
  };
  // fetch_log audit row mirrors the firmlist processor's pattern; the
  // jobs.result_json write happens via runJob → markCompleted (which now
  // honors `totals.result`).
  await env.DB.prepare(
    `INSERT INTO fetch_log (job_id, host, url, tier, status, bytes, block_reason, duration_ms, cost_usd, created_at)
     VALUES (?, ?, ?, 0, 200, 0, ?, ?, 0, ?)`,
  ).bind(
    jobId,
    safeHost(homepage),
    homepage,
    JSON.stringify(summary),
    Date.now() - start,
    now,
  ).run();

  return {
    leadsFound,
    pagesFetched,
    pagesBlocked,
    captchaHits,
    costMs: Date.now() - start,
    result: summary,
  };
}

function pickTeamUrlFromUpsert(r: { website: string | null; domain: string | null }): string | null {
  if (r.website) {
    try { return new URL(r.website).toString(); } catch { /* fall through */ }
  }
  if (r.domain) {
    try { return new URL(`https://${r.domain}`).toString(); } catch { /* fall through */ }
  }
  return null;
}

function pickTeamUrl(f: import("./parsers/firmlists/types").FirmCandidate): string | null {
  if (!f.website) return null;
  // The team-crawl handler in Task #17 expects the firm homepage; it will
  // discover /team /people /about itself. For now we just hand off the site.
  try {
    const u = new URL(f.website);
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Stamp an imported entity with Folk-share provenance.
 *
 * For Folk shares (`picked.name === "folk"`) Task #1 requires every fact
 * to carry `source='folk_share'` and `source_kind='import'`. We achieve
 * that by writing a single canonical import-provenance fact at entity
 * level (`predicate='import_source'`) and by routing each importer-emitted
 * tag through `addTag` with the same source label, so the unified entity
 * graph encodes "this row came from a Folk share" deterministically.
 *
 * For non-Folk firmlist importers the function is still safe to call:
 * it falls back to `source_kind='scrape'` and `source=firmlist:{name}`.
 */
async function tagAsFolkImport(
  env: Env,
  entityId: string,
  importerName: string,
  sourceUrl: string,
  extraTags: string[] | null = null,
): Promise<void> {
  const isFolk = importerName === "folk";
  const source = isFolk ? "folk_share" : `firmlist:${importerName}`;
  const sourceKind = isFolk ? "import" : "scrape";
  try {
    await insertFact(env, {
      entity_id: entityId,
      predicate: "import_source",
      value_text: source,
      source,
      source_kind: sourceKind,
      evidence_url: sourceUrl || null,
      confidence: 1,
    });
  } catch (e) {
    console.warn("tagAsFolkImport.fact", entityId, (e as Error).message);
  }
  if (extraTags?.length) {
    for (const raw of extraTags) {
      if (typeof raw !== "string" || !raw.trim()) continue;
      // Importer emits `role:angel`, `geo_region:middle_east`,
      // `country:FR`, `sector:fintech`, `stage:seed`. We split on the
      // first colon and map to the matching `entity_tags.taxonomy`.
      const [rawTax, ...rest] = raw.split(":");
      const slug = rest.join(":").trim();
      if (!slug) continue;
      const tax = mapTagTaxonomy(rawTax.trim().toLowerCase());
      if (!tax) continue;
      await addTag(env, { entity_id: entityId, taxonomy: tax, slug, source }).catch(() => undefined);
    }
  }
}

function mapTagTaxonomy(prefix: string): Taxonomy | null {
  switch (prefix) {
    case "role":       return "role";
    case "geo":
    case "geo_region":
    case "region":
    case "country":    return "geo";
    case "sector":     return "sector";
    case "stage":      return "stage";
    case "tag":        return "tag";
    default:           return null;
  }
}

async function resolvePersonEntityId(env: Env, email: string | null, linkedin: string | null): Promise<string | null> {
  // Mirrors the dedupe order used in `resolveOrCreate` (dualwrite.ts):
  // canonical email first, then canonical linkedin URL. Returns the
  // unified entity id for a person that already exists, even when
  // `insertLead` merged the new evidence into it (and therefore did not
  // emit a fresh legacy id).
  const ek = canonicalEmail(email);
  if (ek) {
    const row = await env.DB.prepare(
      `SELECT id FROM u_entities
        WHERE primary_email_key = ? AND status NOT IN ('merged','soft_deleted')
        LIMIT 1`,
    ).bind(ek).first<{ id: string }>();
    if (row?.id) return row.id;
  }
  const lk = canonicalLinkedin(linkedin);
  if (lk) {
    const row = await env.DB.prepare(
      `SELECT id FROM u_entities
        WHERE primary_linkedin_key = ? AND status NOT IN ('merged','soft_deleted')
        LIMIT 1`,
    ).bind(lk).first<{ id: string }>();
    if (row?.id) return row.id;
  }
  return null;
}

function safeHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

export async function runJob(msg: JobMessage, env: Env): Promise<void> {
  const { jobId } = msg;
  await markRunning(env, jobId);

  const start = Date.now();
  // ----- Task #22: file-import lifecycle ------------------------------------
  // parse_file / import_file jobs don't produce leads/pages metrics. Their
  // detailed lifecycle lives on file_imports. We just mark the jobs row
  // completed/failed for queue audit purposes.
  if (msg.kind === "parse_file" || msg.kind === "import_file") {
    try {
      const importId = msg.target;
      if (msg.kind === "parse_file") {
        const { processParseFile } = await import("../imports/parse");
        const cfg = (msg.config ?? {}) as { skip_ocr?: boolean };
        await processParseFile(env, importId, { skipOcr: cfg.skip_ocr === true });
      } else {
        const { processImportFile } = await import("../imports/import");
        await processImportFile(env, importId);
      }
      await markCompleted(env, jobId, 0, 0, 0, 0, Date.now() - start, { kind: msg.kind, importId });
      return;
    } catch (e) {
      await markFailed(env, jobId, (e as Error).message, Date.now() - start);
      throw e;
    }
  }
  try {
    // Task #24: investor/company queued enrichment. The bulk
    // /api/investors/enrich/bulk endpoint enqueues profile_list jobs whose
    // `config.enrich_kind` selects the correct executor here. We must NOT
    // route these through processLinktree because target is a lead/company
    // ID, not a URL.
    const cfg = msg.config as { enrich_kind?: string; lead_id?: string; company_id?: string | number } | undefined;
    if (msg.kind === "profile_list" && cfg?.enrich_kind === "investor") {
      const { enrichLead } = await import("../enrichment/orchestrator");
      const leadId = String(cfg.lead_id ?? msg.target);
      const outcome = await enrichLead(env, leadId);
      await markCompleted(env, jobId, 0, 0, 0, 0, Date.now() - start,
        { kind: msg.kind, mode: "investor_enrich", lead_id: leadId, fields_changed: outcome.fields_changed });
      return;
    }
    if (msg.kind === "profile_list" && cfg?.enrich_kind === "company") {
      // Real company-enrichment providers land in Task #25; for now this
      // succeeds-noop so the queue doesn't keep retrying. Cache is busted
      // by the API route on enqueue.
      await markCompleted(env, jobId, 0, 0, 0, 0, Date.now() - start,
        { kind: msg.kind, mode: "company_enrich_noop", company_id: cfg.company_id ?? msg.target });
      return;
    }
    // Task #27: every top-level pipeline phase is wrapped in timedStep so
    // workflow_step_log gets a row with timing/error_code/attempt for every
    // job. The dashboard /api/errors/job/:id query renders these.
    const { timedStep } = await import("../db/error_log.js");
    const stepName = `pipeline:${msg.kind}`;
    let totals: { leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number; result?: Record<string, unknown> };
    totals = await timedStep(env, jobId, stepName, async () => {
      if (msg.kind === "linktree" || msg.kind === "profile_list") {
        return processLinktree(env, jobId, msg.target, msg.config);
      } else if (msg.kind === "discover") {
        return processDiscover(env, jobId, msg.target, msg.config);
      } else if (msg.kind === "firmlist") {
        return processFirmlist(env, jobId, msg.target, msg.config);
      } else if (msg.kind === "firm_team_crawl") {
        return processFirmTeamCrawl(env, jobId, msg.target, msg.config);
      } else {
        return processSingleUrl(env, jobId, msg.target, msg.config);
      }
    }, { meta: { target: msg.target, kind: msg.kind } });

    if (await isCancelled(env, jobId)) {
      await env.DB.prepare(
        `UPDATE jobs SET cost_ms = COALESCE(cost_ms,0) + ?, leads_found = ?, pages_fetched = ?, pages_blocked = ?, captcha_hits = ?, cancelled_at = ?, finished_at = ? WHERE id = ?`,
      )
        .bind(
          Date.now() - start,
          totals.leadsFound,
          totals.pagesFetched,
          totals.pagesBlocked,
          totals.captchaHits,
          new Date().toISOString(),
          new Date().toISOString(),
          jobId,
        )
        .run();
      return;
    }

    // Allow per-job summaries (e.g. firm_team_crawl) to ride through to the
    // jobs.result_json column instead of being clobbered by the default
    // {kind,target} stub.
    const customResult = (totals as { result?: Record<string, unknown> }).result;
    await markCompleted(
      env,
      jobId,
      totals.leadsFound,
      totals.pagesFetched,
      totals.pagesBlocked,
      totals.captchaHits,
      Date.now() - start,
      customResult ?? { kind: msg.kind, target: msg.target },
    );
  } catch (e) {
    await markFailed(env, jobId, (e as Error).message, Date.now() - start);
    throw e;
  }
}
