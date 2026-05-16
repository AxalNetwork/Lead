import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities } from "../../html";
import type { FirmCandidate, FirmlistImportResult, ImporterHints } from "./types";
import { deriveDomain, rowToCandidate } from "./_helpers";
import { applyHints, awaitHostSlot, importKey } from "./aggregators/_base";

/**
 * Mercury Investor Database (mercury.com/investor-database) importer.
 *
 * Task #2 spec calls for capturing the underlying SPA XHR
 * `/api/v1/investors` with cursor pagination and extracting:
 *   name, firm, role, location, stage, sector, check_size, twitter,
 *   linkedin, website, bio.
 *
 * Strategy (in order, fail-soft):
 *   1. Hit `https://mercury.com/api/v1/investors?cursor=…&limit=100`
 *      directly. The endpoint occasionally fronts CORS but the worker
 *      bypasses browser policy. Walk pages until the response has no
 *      `next_cursor` (or until the page budget — 50 pages × 100 = 5k
 *      rows — is exhausted).
 *   2. Fallback to a browser-rendered scrape of the public investor
 *      cards if the API returns 4xx/5xx or empty payloads.
 */
const API_BASE = "https://mercury.com/api/v1/investors";
const API_PAGE_LIMIT = 100;
const API_MAX_PAGES = 50;

export async function importFirms(url: string, env: Env, hints?: ImporterHints): Promise<FirmlistImportResult> {
  const firms: FirmCandidate[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  // ---- 1) Try the structured API first. ----
  let apiOk = false;
  let cursor: string | null = null;
  let totalSeen = 0;
  for (let page = 0; page < API_MAX_PAGES; page++) {
    await awaitHostSlot(env, API_BASE);
    const apiUrl = buildApiUrl(cursor);
    let resp: Response;
    try {
      resp = await fetch(apiUrl, {
        headers: {
          "accept": "application/json",
          "user-agent": "AIDataSignal/1.0 (+https://aidatasignal.com)",
          "referer": "https://mercury.com/investor-database",
        },
      });
    } catch (e) {
      errors.push(`api_fetch_throw:${(e as Error).message}`);
      break;
    }
    if (!resp.ok) {
      errors.push(`api_status_${resp.status}`);
      break;
    }
    let json: unknown;
    try { json = await resp.json(); }
    catch { errors.push("api_json_parse_failed"); break; }
    const { records, nextCursor } = pickRecords(json);
    if (!records.length) {
      if (page === 0) errors.push("api_empty_payload");
      break;
    }
    apiOk = true;
    totalSeen += records.length;
    for (const r of records) {
      const name = String(r.name ?? "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      firms.push(buildFirmFromApi(r, url));
    }
    if (!nextCursor) break;
    cursor = nextCursor;
  }

  // ---- 2) HTML fallback when API is unavailable. ----
  if (!apiOk) {
    errors.push("api_unavailable_falling_back_to_html");
    const html = await scrapeHtmlFallback(url, env, seen, firms);
    totalSeen += html;
  }

  for (const f of firms) {
    if (!f.domain && f.website) f.domain = deriveDomain(f.website);
    applyHints(f, hints);
  }
  return { firms, totalSeen, errors: errors.length ? errors : undefined };
}

function buildApiUrl(cursor: string | null): string {
  const u = new URL(API_BASE);
  u.searchParams.set("limit", String(API_PAGE_LIMIT));
  if (cursor) u.searchParams.set("cursor", cursor);
  return u.toString();
}

interface ApiRecord {
  name?: string; firm?: string; role?: string; location?: string;
  stage?: string | string[]; sector?: string | string[];
  check_size?: string; checkSize?: string;
  twitter?: string; linkedin?: string; website?: string; url?: string;
  bio?: string; description?: string;
  [k: string]: unknown;
}

/** Mercury's payload shape varies slightly across versions; try the
 *  common envelopes (`{records,next_cursor}`, `{data,nextCursor}`,
 *  plain arrays) and harvest whichever path looks right. */
function pickRecords(json: unknown): { records: ApiRecord[]; nextCursor: string | null } {
  if (!json || typeof json !== "object") return { records: [], nextCursor: null };
  const o = json as Record<string, unknown>;
  const next = (typeof o.next_cursor === "string" ? o.next_cursor
    : typeof o.nextCursor === "string" ? o.nextCursor
    : typeof o.cursor === "string" ? o.cursor
    : null);
  const arr = Array.isArray(o.records) ? o.records
    : Array.isArray(o.data) ? o.data
    : Array.isArray(o.investors) ? o.investors
    : Array.isArray(o.results) ? o.results
    : null;
  if (arr) return { records: arr as ApiRecord[], nextCursor: next };
  if (Array.isArray(json)) return { records: json as ApiRecord[], nextCursor: null };
  return { records: [], nextCursor: null };
}

function buildFirmFromApi(r: ApiRecord, sourceUrl: string): FirmCandidate {
  const stages = Array.isArray(r.stage) ? r.stage.join(",") : (r.stage ?? null);
  const sectors = Array.isArray(r.sector) ? r.sector.join(",") : (r.sector ?? null);
  const check = r.check_size ?? r.checkSize ?? null;
  const website = r.website ?? r.url ?? null;
  const firmName = r.firm ?? r.name ?? "";
  const cand = rowToCandidate({
    name: firmName,
    website,
    thesis: r.bio ?? r.description ?? null,
    stages,
    sectors,
    LinkedIn: r.linkedin,
    Twitter: r.twitter,
    City: r.location,
    check: check,
  }, sourceUrl);
  const firm: FirmCandidate = cand?.candidate ?? {
    name: firmName,
    domain: null,
    website,
    hq_city: r.location ?? null,
    hq_country_iso2: null,
    hq_region: null,
    kind: null,
    socials: null,
    thesis: r.bio ?? r.description ?? null,
    linkedin: r.linkedin ?? null,
    twitter: r.twitter ?? null,
  } as FirmCandidate;
  firm.source_url = sourceUrl;
  // Per-firm tags: role / sector / stage tags from API fields land in
  // entity_tags via the pipeline's tagAsFolkImport path.
  const tags: string[] = [];
  if (r.role && typeof r.role === "string") tags.push(`role:${r.role.toLowerCase().replace(/\s+/g, "_")}`);
  if (Array.isArray(r.stage)) for (const s of r.stage) tags.push(`stage:${String(s).toLowerCase().replace(/\s+/g, "_")}`);
  else if (typeof r.stage === "string") tags.push(`stage:${r.stage.toLowerCase().replace(/\s+/g, "_")}`);
  if (Array.isArray(r.sector)) for (const s of r.sector) tags.push(`sector:${String(s).toLowerCase().replace(/\s+/g, "_")}`);
  else if (typeof r.sector === "string") tags.push(`sector:${r.sector.toLowerCase().replace(/\s+/g, "_")}`);
  (firm as { tags?: string[] }).tags = tags;
  (firm as { import_key?: string }).import_key = importKey("mercury", firmName);
  return firm;
}

/** HTML fallback — minimal scrape of `mercury.com/investor-database`
 *  card anchors. Returns the number of rows seen. */
async function scrapeHtmlFallback(url: string, env: Env, seen: Set<string>, firms: FirmCandidate[]): Promise<number> {
  await awaitHostSlot(env, url);
  const fetched = await fetchPage(env, url, { forceBrowser: true });
  if (!fetched.ok) return 0;
  const cardRe = /<a\b[^>]*href="([^"]*\/investor-database\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  let totalSeen = 0;
  while ((m = cardRe.exec(fetched.html)) !== null) {
    totalSeen += 1;
    const href = m[1];
    const inner = m[2];
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!text) continue;
    const parts = text.split(/[•·\|]/).map((s) => s.trim()).filter(Boolean);
    const name = parts[0];
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = rowToCandidate({
      name,
      check: parts[1],
      stage: parts[2],
      geo: parts[3],
    }, url);
    if (cand) {
      try { cand.candidate.source_url = new URL(href, url).toString(); }
      catch { cand.candidate.source_url = url; }
      (cand.candidate as { import_key?: string }).import_key = importKey("mercury", name);
      firms.push(cand.candidate);
    }
  }
  return totalSeen;
}
