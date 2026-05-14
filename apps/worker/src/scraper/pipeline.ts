import type { Env, JobMessage, ParsedLead } from "../types";
import { fetchPage, fetchBytes } from "./fetcher";
import { selectParser } from "./parsers";
import { parsePdf } from "./parsers/pdf";
import { extractDomain } from "./normalize";
import { discoverUrls } from "./fallbacks/sitemap";
import { tosBlockedReason } from "./tos";
import { discoverPartnersForFirm, discoverByPersona } from "../discovery/discover";
import { saveCandidates } from "../discovery/store";

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
    `UPDATE jobs SET status = 'completed', finished_at = ?, leads_found = ?, pages_fetched = ?, pages_blocked = ?, captcha_hits = ?, cost_ms = COALESCE(cost_ms,0) + ?, result_json = ? WHERE id = ?`,
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

  const decision = await resolveIncoming(env.DB, incoming, { jobId, provider: parserName });

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

  const repo = new LeadsRepo(env.DB);
  await repo.insert(lead);

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

async function processSingleUrl(
  env: Env,
  jobId: string,
  url: string,
): Promise<{ leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number }> {
  let leadsFound = 0;
  let pagesFetched = 0;
  let pagesBlocked = 0;
  let captchaHits = 0;
  let costMs = 0;

  if (await isCancelled(env, jobId)) return { leadsFound, pagesFetched, pagesBlocked, captchaHits, costMs };

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

export async function runJob(msg: JobMessage, env: Env): Promise<void> {
  const { jobId } = msg;
  await markRunning(env, jobId);

  const start = Date.now();
  try {
    let totals: { leadsFound: number; pagesFetched: number; pagesBlocked: number; captchaHits: number; costMs: number };
    if (msg.kind === "linktree") {
      totals = await processLinktree(env, jobId, msg.target, msg.config);
    } else if (msg.kind === "profile_list") {
      totals = await processLinktree(env, jobId, msg.target, msg.config);
    } else if (msg.kind === "discover") {
      totals = await processDiscover(env, jobId, msg.target, msg.config);
    } else {
      totals = await processSingleUrl(env, jobId, msg.target);
    }

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

    await markCompleted(
      env,
      jobId,
      totals.leadsFound,
      totals.pagesFetched,
      totals.pagesBlocked,
      totals.captchaHits,
      Date.now() - start,
      { kind: msg.kind, target: msg.target },
    );
  } catch (e) {
    await markFailed(env, jobId, (e as Error).message, Date.now() - start);
    throw e;
  }
}
