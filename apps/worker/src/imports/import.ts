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
import { parseCsv, type ParsedTable } from "./csv";
import { parseSpreadsheet } from "./xlsx_parser";
import { parsePdfTables } from "./pdf_parser";
import type { Entity, MappedField } from "./auto_map";
import { rowToCandidate } from "../scraper/parsers/firmlists/_helpers";
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
  mime: string | null;
  r2_key: string;
  entity: Entity | null;
  scrape_urls: number;
  column_map_json: string | null;
  created_by: string | null;
}

export async function processImportFile(env: Env, importId: string): Promise<void> {
  const row = await env.DB
    .prepare("SELECT id, filename, mime, r2_key, entity, scrape_urls, column_map_json, created_by FROM file_imports WHERE id = ?")
    .bind(importId)
    .first<FileImportRow>();
  if (!row) throw new Error(`file_import_not_found:${importId}`);

  await env.DB
    .prepare("UPDATE file_imports SET status = 'importing', updated_at = ? WHERE id = ?")
    .bind(new Date().toISOString(), importId)
    .run();

  try {
    // Re-parse straight from R2 (no full-row KV cache — KV values are capped
    // at 25 MB and a 10k-row sheet routinely exceeds that. R2 streaming +
    // re-parse keeps memory bounded and lets us resume after a worker swap).
    const obj = await env.UPLOADS.get(row.r2_key);
    if (!obj) throw new Error("upload_object_missing");
    const bytes = await obj.arrayBuffer();
    const tables = await parseByKind(bytes, extOf(row.filename), row.mime);
    if (!tables.length) throw new Error("no_table_found");
    tables.sort((a, b) => b.rows.length - a.rows.length);
    const parsed = tables[0];
    const portfolioTables = entity_isFirms(row.entity)
      ? tables.slice(1).filter(isPortfolioTable)
      : [];

    const map = parseMap(row.column_map_json);
    const entity: Entity = row.entity === "leads" ? "leads" : "firms";

    let firmsCreated = 0, firmsUpdated = 0, leadsCreated = 0, leadsUpdated = 0;
    let portfolioCreated = 0;
    const errors: string[] = [];
    const sourceUrl = `upload://${importId}/${row.filename}`;
    const importedFrom = `upload:${entity}`;
    /** Unique firm ids we touched so PDF portfolio tables can be attached
     *  even when many rows resolve to the same firm. */
    const firmIdsTouched = new Set<number>();

    // Stream in batches so we don't OOM and so progress is visible if the
    // worker restarts mid-import. Each batch persists progress at the end.
    for (let off = 0; off < parsed.rows.length; off += BATCH_SIZE) {
      const slice = parsed.rows.slice(off, off + BATCH_SIZE);
      for (const raw of slice) {
        const projected = projectRow(raw, map);
        if (entity === "firms") {
          const r = await tryUpsertFirm(env, projected, sourceUrl, importedFrom);
          if (r.action === "created") firmsCreated += 1;
          else if (r.action === "updated") firmsUpdated += 1;
          else if (r.action === "error") errors.push(`firm:${projected.name ?? "?"}`);
          if (r.firmId != null) firmIdsTouched.add(r.firmId);
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

    // ---- PDF portfolio attribution. When the PDF contained per-firm
    // portfolio tables and exactly one firm was upserted, attach every
    // portfolio row to it via firm_portfolio. Uses D1 batch() so the
    // entire portfolio for a firm goes in as one atomic transaction.
    if (portfolioTables.length && firmIdsTouched.size === 1) {
      const firmId = firmIdsTouched.values().next().value as number;
      portfolioCreated = await insertPortfolioRows(env, firmId, portfolioTables, sourceUrl);
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
             portfolio_created = ?,
             error = CASE WHEN ? = '' THEN NULL ELSE ? END,
             updated_at = ?
       WHERE id = ?`,
    ).bind(
      queuedJobs,
      portfolioCreated,
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

interface FirmUpsertResult { action: "created" | "updated" | "unchanged" | "error" | "skip"; firmId: number | null }

async function tryUpsertFirm(
  env: Env,
  fields: Record<string, string>,
  sourceUrl: string,
  importedFrom: string,
): Promise<FirmUpsertResult> {
  const name = (fields.name ?? "").trim();
  if (!name) return { action: "skip", firmId: null };
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
  if (!built) return { action: "skip", firmId: null };
  const candidate: FirmCandidate = built.candidate;
  // Fill website from domain when missing — upsertFirm requires at least one.
  if (!candidate.website && candidate.domain) candidate.website = `https://${candidate.domain}`;
  if (!candidate.website && !candidate.domain) return { action: "skip", firmId: null };
  try {
    const r = await upsertFirm(env, candidate, importedFrom);
    return { action: r.action, firmId: r.firmId };
  } catch {
    return { action: "error", firmId: null };
  }
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
    // the column map). No dedupe_review row is recorded for this path —
    // the merge already preserves the prior lead and adds new evidence.
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

function entity_isFirms(e: string | null | undefined): boolean {
  return e === "firms" || e == null;
}

function extOf(filename: string): string {
  const m = /\.([a-z0-9]+)$/i.exec(filename);
  return m ? m[1].toLowerCase() : "";
}

async function parseByKind(bytes: ArrayBuffer, ext: string, mime: string | null): Promise<ParsedTable[]> {
  const m = (mime || "").toLowerCase();
  if (ext === "pdf" || m.includes("pdf")) return parsePdfTables(bytes);
  if (ext === "csv" || m.includes("text/csv")) return [parseCsv(new TextDecoder().decode(bytes))];
  if (ext === "tsv") return [parseCsv(new TextDecoder().decode(bytes), "\t")];
  return [await parseSpreadsheet(bytes)];
}

/** Heuristic: a secondary table is a firm portfolio table when its headers
 *  include a company-name column plus at least one investment-shape column
 *  (year, stage, amount, round, lead, exit). */
function isPortfolioTable(t: ParsedTable): boolean {
  const hs = t.headers.map((h) => h.toLowerCase().trim());
  const hasCompany = hs.some((h) => /\b(company|portfolio|investment|name)\b/.test(h));
  const hasShape = hs.some((h) => /\b(year|stage|amount|round|raised|exit|lead)\b/.test(h));
  return hasCompany && hasShape && t.rows.length >= 1;
}

interface PortfolioCols {
  company: string | null; domain: string | null; url: string | null;
  year: string | null; stage: string | null; amount: string | null;
  isLead: string | null; outcome: string | null; exit: string | null;
}

function detectPortfolioCols(headers: string[]): PortfolioCols {
  const find = (re: RegExp): string | null => headers.find((h) => re.test(h.toLowerCase())) ?? null;
  return {
    company: find(/\b(company|portfolio|investment|name)\b/),
    domain:  find(/\b(domain|website|url|site)\b/),
    url:     find(/\b(url|link|profile)\b/),
    year:    find(/\b(year|date|invested|since)\b/),
    stage:   find(/\b(stage|round|series)\b/),
    amount:  find(/\b(amount|check|raised|invested|usd|ticket)\b/),
    isLead:  find(/\blead\b/),
    outcome: find(/\b(outcome|status|result)\b/),
    exit:    find(/\b(exit|valuation|acqui|ipo)\b/),
  };
}

function parseYearMaybe(v: string | undefined | null): number | null {
  if (!v) return null;
  const m = /\b(19|20)\d{2}\b/.exec(String(v));
  return m ? parseInt(m[0], 10) : null;
}

function parseUsdMaybe(v: string | undefined | null): number | null {
  if (!v) return null;
  const s = String(v).toLowerCase().replace(/[, ]+/g, "");
  const m = /([\d.]+)\s*([kmb])?/.exec(s);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const mult = m[2] === "b" ? 1e9 : m[2] === "m" ? 1e6 : m[2] === "k" ? 1e3 : 1;
  return Math.round(n * mult);
}

/** Insert all portfolio rows from PDF secondary tables for `firmId`, one
 *  D1.batch() per source table so each table is atomic. */
async function insertPortfolioRows(
  env: Env,
  firmId: number,
  tables: ParsedTable[],
  sourceUrl: string,
): Promise<number> {
  let created = 0;
  for (const t of tables) {
    const cols = detectPortfolioCols(t.headers);
    if (!cols.company) continue;
    const stmts: D1PreparedStatement[] = [];
    const stmt = env.DB.prepare(
      `INSERT INTO firm_portfolio
        (firm_id, company_name, company_domain, company_url, investment_year,
         stage, amount_usd, is_lead, outcome, exit_value_usd, source_url)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of t.rows) {
      const company = (row[cols.company] ?? "").trim();
      if (!company) continue;
      stmts.push(stmt.bind(
        firmId,
        company,
        cols.domain ? (row[cols.domain] || null) : null,
        cols.url ? (row[cols.url] || null) : null,
        parseYearMaybe(cols.year ? row[cols.year] : null),
        cols.stage ? (row[cols.stage] || null) : null,
        parseUsdMaybe(cols.amount ? row[cols.amount] : null),
        cols.isLead && /\b(lead|y|yes|true|1)\b/i.test(row[cols.isLead] ?? "") ? 1 : 0,
        cols.outcome ? (row[cols.outcome] || null) : null,
        parseUsdMaybe(cols.exit ? row[cols.exit] : null),
        sourceUrl,
      ));
    }
    if (!stmts.length) continue;
    // D1 batch caps at ~100 statements per call. Chunk if larger.
    for (let i = 0; i < stmts.length; i += 100) {
      const chunk = stmts.slice(i, i + 100);
      try { await env.DB.batch(chunk); created += chunk.length; } catch { /* ignore portfolio insert failures */ }
    }
  }
  return created;
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
