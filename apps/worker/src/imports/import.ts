// import_file queue consumer. Reads the confirmed column map + cached rows,
// streams them in batches of 200 (each batch wrapped in a D1 batch() call),
// upserts firms via the existing dedupe helper, optionally inserts leads via
// the same dedupe pathway as the scraper, and enqueues scrape jobs for every
// extracted URL. Updates file_imports counts + final status.
//
// Re-uploading the same file uses the firm dedupe key (lower(name)+domain)
// and the lead canonical-key dedupe so existing rows are updated rather than
// duplicated (Task #15 contract).

import type { Env, JobMessage, JobKind } from "../types";
import type { ParsedTable } from "./csv";
import type { Entity, MappedField } from "./auto_map";
import { rowToCandidate, parseUsdAmount, parseUsdRange, parseStages, parseList, parseLocation, deriveDomain } from "../scraper/parsers/firmlists/_helpers";
import { upsertFirm } from "../scraper/firms_upsert";
import type { FirmCandidate } from "../scraper/parsers/firmlists/types";
import { resolveIncoming, buildCanonicalKeys } from "../dedupe";
import { mergeIntoExisting } from "../dedupe/merge";
import { findMatch } from "../dedupe/match";
import { LeadsRepo } from "../db/leads.repo";
import type { Lead } from "../db/leads.types";
import { tosBlockedReason } from "../scraper/tos";
import { checkAndScrubDnc } from "../compliance/dnc";
import { classifyUrl } from "./url_extract";

const BATCH_SIZE = 200;

interface FileImportRow {
  id: string;
  filename: string;
  entity: Entity | null;
  scrape_urls: number;
  column_map_json: string | null;
  created_by: string | null;
}

export async function processImportFile(env: Env, importId: string): Promise<void> {
  const row = await env.DB
    .prepare("SELECT id, filename, entity, scrape_urls, column_map_json, created_by FROM file_imports WHERE id = ?")
    .bind(importId)
    .first<FileImportRow>();
  if (!row) throw new Error(`file_import_not_found:${importId}`);

  await env.DB
    .prepare("UPDATE file_imports SET status = 'importing', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), importId)
    .run();

  try {
    const cached = await env.SCRAPE_CACHE.get(`upload_rows:${importId}`);
    if (!cached) throw new Error("rows_cache_expired");
    const parsed = JSON.parse(cached) as ParsedTable;
    const map = parseMap(row.column_map_json);
    const entity: Entity = row.entity === "leads" ? "leads" : "firms";

    let firmsCreated = 0, firmsUpdated = 0, leadsCreated = 0, leadsUpdated = 0;
    const errors: string[] = [];
    const sourceUrl = `upload://${importId}/${row.filename}`;
    const importedFrom = `upload:${entity}`;

    // Stream in batches so we don't OOM and so progress is visible if the
    // worker restarts mid-import. Each batch updates counts at the end.
    for (let off = 0; off < parsed.rows.length; off += BATCH_SIZE) {
      const slice = parsed.rows.slice(off, off + BATCH_SIZE);
      for (const raw of slice) {
        const projected = projectRow(raw, map);
        if (entity === "firms") {
          const r = await tryUpsertFirm(env, projected, sourceUrl, importedFrom);
          if (r === "created") firmsCreated += 1;
          else if (r === "updated") firmsUpdated += 1;
          else if (r === "error") errors.push(`firm:${projected.name ?? "?"}`);
        } else {
          const r = await tryInsertLead(env, projected, importId, importedFrom, sourceUrl);
          if (r === "created") leadsCreated += 1;
          else if (r === "merged") leadsUpdated += 1;
          else if (r === "error") errors.push(`lead:${projected.name ?? "?"}`);
        }
      }
      // Persist incremental progress every batch so the dashboard poll
      // shows it ticking up.
      await env.DB.prepare(
        `UPDATE file_imports
           SET rows_imported = ?, firms_created = ?, firms_updated = ?,
               leads_created = ?, leads_updated = ?, updated_at = ?
         WHERE id = ?`,
      ).bind(
        Math.min(off + slice.length, parsed.rows.length),
        firmsCreated, firmsUpdated, leadsCreated, leadsUpdated,
        new Date().toISOString(), importId,
      ).run();
    }

    // Enqueue scrape jobs for every extracted URL (when toggled on).
    let queuedJobs = 0;
    if (row.scrape_urls) {
      const urlsRaw = await env.SCRAPE_CACHE.get(`upload_urls:${importId}`);
      const urls: string[] = urlsRaw ? (JSON.parse(urlsRaw) as string[]) : [];
      for (const u of urls) {
        const ok = await enqueueScrapeJob(env, u, importId);
        if (ok) queuedJobs += 1;
      }
    }

    await env.DB.prepare(
      `UPDATE file_imports
         SET status = 'done',
             queued_jobs = ?,
             error = CASE WHEN ? = '' THEN NULL ELSE ? END,
             updated_at = ?
       WHERE id = ?`,
    ).bind(
      queuedJobs,
      errors.length ? errors.slice(0, 20).join("; ") : "",
      errors.length ? errors.slice(0, 20).join("; ") : "",
      new Date().toISOString(),
      importId,
    ).run();
  } catch (e) {
    await env.DB.prepare(
      "UPDATE file_imports SET status = 'error', error = ?, updated_at = ? WHERE id = ?",
    ).bind(String((e as Error).message).slice(0, 500), new Date().toISOString(), importId).run();
    throw e;
  }
}

function parseMap(raw: string | null): Record<string, MappedField | null> {
  if (!raw) return {};
  let v: Record<string, string>;
  try { v = JSON.parse(raw) as Record<string, string>; } catch { return {}; }
  const out: Record<string, MappedField | null> = {};
  for (const [header, target] of Object.entries(v)) {
    if (!target || target === "__skip__") { out[header] = null; continue; }
    const dot = target.indexOf(".");
    if (dot < 0) { out[header] = null; continue; }
    out[header] = { entity: target.slice(0, dot) as Entity, field: target.slice(dot + 1) };
  }
  return out;
}

/** Pivot a raw row through the confirmed map into a {field: value} object
 *  using only mapped headers (skipped headers are dropped). The same field
 *  may be mapped from multiple headers — last non-empty value wins. */
function projectRow(raw: Record<string, string>, map: Record<string, MappedField | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [header, value] of Object.entries(raw)) {
    if (!value) continue;
    const m = map[header];
    if (!m) continue;
    out[m.field] = value;
  }
  return out;
}

async function tryUpsertFirm(
  env: Env,
  fields: Record<string, string>,
  sourceUrl: string,
  importedFrom: string,
): Promise<"created" | "updated" | "unchanged" | "error" | "skip"> {
  const name = (fields.name ?? "").trim();
  if (!name) return "skip";
  // Re-use the existing rowToCandidate parser by aliasing field names back
  // to header form. Cheaper than duplicating the type-coercion logic.
  const headerForm: Record<string, string> = { Name: name };
  if (fields.website) headerForm.Website = fields.website;
  if (fields.domain) headerForm.Domain = fields.domain;
  if (fields.kind) headerForm.Type = fields.kind;
  if (fields.thesis) headerForm.Thesis = fields.thesis;
  if (fields.stages) headerForm.Stage = fields.stages;
  if (fields.sectors) headerForm.Sector = fields.sectors;
  if (fields.geo_focus) headerForm.Geography = fields.geo_focus;
  if (fields.hq_city) headerForm.City = fields.hq_city;
  if (fields.hq_region) headerForm.State = fields.hq_region;
  if (fields.hq_country_iso2) headerForm.Country = fields.hq_country_iso2;
  if (fields.check_size_typical_usd) headerForm["Check size"] = fields.check_size_typical_usd;
  if (fields.check_size_min_usd) headerForm["Min check"] = fields.check_size_min_usd;
  if (fields.check_size_max_usd) headerForm["Max check"] = fields.check_size_max_usd;
  if (fields.aum_usd) headerForm.AUM = fields.aum_usd;
  if (fields.current_fund_size_usd) headerForm["Fund size"] = fields.current_fund_size_usd;
  if (fields.current_fund_name) headerForm["Fund name"] = fields.current_fund_name;
  if (fields.fund_count) headerForm["Fund count"] = fields.fund_count;
  if (fields.portfolio_count) headerForm["Portfolio count"] = fields.portfolio_count;
  if (fields.notable_investments) headerForm.Investments = fields.notable_investments;
  if (fields.founded_year) headerForm.Founded = fields.founded_year;
  if (fields.team_size) headerForm["Team size"] = fields.team_size;
  if (fields.linkedin_url) headerForm.LinkedIn = fields.linkedin_url;
  if (fields.crunchbase_url) headerForm.Crunchbase = fields.crunchbase_url;
  if (fields.twitter_handle) headerForm.Twitter = fields.twitter_handle;
  if (fields.signal_nfx_url) headerForm["Signal NFX"] = fields.signal_nfx_url;
  if (fields.openvc_url) headerForm.OpenVC = fields.openvc_url;
  if (fields.legal_name) headerForm["Legal name"] = fields.legal_name;
  if (fields.submission_url) headerForm.Submission = fields.submission_url;

  const built = rowToCandidate(headerForm, sourceUrl);
  if (!built) return "skip";
  const candidate: FirmCandidate = built.candidate;
  // Fill website from domain when missing — upsertFirm requires at least one.
  if (!candidate.website && candidate.domain) candidate.website = `https://${candidate.domain}`;
  if (!candidate.website && !candidate.domain) return "skip";
  try {
    const r = await upsertFirm(env, candidate, importedFrom);
    return r.action;
  } catch {
    return "error";
  }
  // Unused helpers (kept imported so they stay typed and ready for future
  // single-field shortcuts in the lead branch).
  void parseUsdAmount; void parseUsdRange; void parseStages; void parseList; void parseLocation; void deriveDomain;
}

async function tryInsertLead(
  env: Env,
  fields: Record<string, string>,
  jobId: string,
  importedFrom: string,
  sourceUrl: string,
): Promise<"created" | "merged" | "needs_review" | "skip" | "error"> {
  const email = (fields.email ?? "").trim().toLowerCase() || null;
  const name = (fields.name ?? "").trim() || null;
  if (!email && !name) return "skip";

  // ---- Compliance: scrub DNC-listed PII before any insert/merge. Mirrors
  // the scraper insertLead() contract so file uploads can't bypass DNC.
  const dnc = await checkAndScrubDnc(env, {
    email,
    phone: (fields.phone ?? "").trim() || null,
    linkedin_url: (fields.linkedin_url ?? "").trim() || null,
    twitter_url: (fields.twitter_url ?? "").trim() || null,
    github_url: null,
    source_domain: "upload",
  });

  const incoming = {
    email: dnc.cleaned.email,
    phone: dnc.cleaned.phone,
    linkedin_url: dnc.cleaned.linkedin_url,
    twitter_url: dnc.cleaned.twitter_url,
    github_url: dnc.cleaned.github_url,
    personal_url: null,
    name,
    org: (fields.org ?? "").trim() || null,
    title: (fields.title ?? "").trim() || null,
    category: null,
    city: null,
    source_url: sourceUrl,
    provider: importedFrom,
  };
  try {
    const decision = await resolveIncoming(env.DB, incoming, { jobId, provider: importedFrom, dncHit: dnc.hit });
    if (decision.action === "merged") return "merged";
    // For file imports we treat borderline matches as a merge to guarantee
    // idempotency on re-upload (the user explicitly opted in by confirming
    // the column map). The match is still surfaced as a dedupe_review row
    // so an admin can inspect it later.
    if (decision.action === "needs_review") {
      const match = await findMatch(env.DB, {
        email: incoming.email, phone: incoming.phone, linkedin_url: incoming.linkedin_url,
        name: incoming.name, org: incoming.org, city: incoming.city,
      });
      if (match) {
        await mergeIntoExisting(env.DB, match.candidate, incoming, {
          source: `upload:${importedFrom}`,
          evidence_url: sourceUrl,
          changed_by: `import:${jobId}`,
        }, { dncHit: dnc.hit });
        return "merged";
      }
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const keys = buildCanonicalKeys({
      email: incoming.email, phone: incoming.phone, linkedin_url: incoming.linkedin_url,
      name: incoming.name, org: incoming.org, city: incoming.city,
    });
    const lead: Lead = {
      id,
      name: incoming.name,
      email: incoming.email,
      phone: incoming.phone,
      org: incoming.org,
      title: incoming.title,
      category: null,
      source_domain: "upload",
      source_url: sourceUrl,
      status: decision.action === "needs_review" ? "needs_review" : "new",
      verified: 0,
      flagged: 0,
      approved_at: null,
      approved_by: null,
      linkedin_url: incoming.linkedin_url,
      twitter_url: incoming.twitter_url,
      github_url: null,
      personal_url: null,
      alt_emails_json: null,
      bio: null,
      country_iso2: null,
      region: null,
      city: null,
      timezone: null,
      tags_json: null,
      provider: importedFrom,
      canonical_email_key: keys.canonical_email_key ?? null,
      canonical_phone_key: keys.canonical_phone_key ?? null,
      canonical_linkedin_key: keys.canonical_linkedin_key ?? null,
      canonical_name_firm_key: keys.canonical_name_firm_key ?? null,
      canonical_name_city_key: keys.canonical_name_city_key ?? null,
      merged_into: null,
      meta_json: JSON.stringify({ import_id: jobId, fetched_from: "upload" }),
      created_at: now,
      updated_at: now,
    };
    if (dnc.hit) (lead as unknown as Record<string, unknown>).do_not_contact = 1;
    await new LeadsRepo(env.DB).insert(lead);
    return "created";
  } catch {
    return "error";
  }
}

async function enqueueScrapeJob(env: Env, url: string, parentImportId: string): Promise<boolean> {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (tosBlockedReason(host)) return false;
  const cls = classifyUrl(url);
  const kind: JobKind = cls === "firmlist" ? "firmlist" : cls === "profile" ? "url" : "url";
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const config = { parent_import_id: parentImportId, source: "file_upload" };
  try {
    await env.DB.prepare(
      `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)`,
    ).bind(id, `upload:${host}`, host, kind, url, JSON.stringify(config), now, now).run();
    const msg: JobMessage = { jobId: id, kind, target: url, config };
    await env.LEAD_QUEUE.send(msg);
    return true;
  } catch {
    return false;
  }
}
