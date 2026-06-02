// Task #13 — one-time (idempotent) backfill of firms.hq_country_iso2.
//
// Many firms were scraped before country resolution ran at ingest: the
// Crunchbase parser (and others) left `hq_country_iso2` NULL while stashing
// the raw country NAME in `notes` as `hq_country_name=...`. This routine
// resolves those rows to a valid ISO2 code using only data already on the
// firm row — no external geocoding — in priority order:
//   1. `notes` `hq_country_name=<name>`  → name→ISO2 table
//   2. `hq_region`                       → name→ISO2 table (region is
//                                          sometimes itself a country)
//   3. website / domain ccTLD            → TLD→ISO2 map
//
// Idempotent: only rows with NULL `hq_country_iso2` are scanned, and the
// UPDATE re-asserts the NULL guard. Only valid ISO2 codes are written —
// unresolved rows are left NULL and counted so coverage stays honest.

import type { Env } from "../types";
import { parseCountryIso2 } from "../imports/coercers";

// Country-code TLDs → ISO2. Generic TLDs (com/org/net/io/vc/co/ai/app/…)
// are deliberately ABSENT so a ".com" never resolves to a country. `.uk`
// maps to GB (the ISO2 for the UK). Only unambiguous ccTLDs are listed.
const TLD_TO_ISO2: Record<string, string> = {
  us: "US", ca: "CA", mx: "MX", br: "BR", ar: "AR", cl: "CL", co: "CO", pe: "PE", ve: "VE",
  uk: "GB", gb: "GB", ie: "IE", fr: "FR", es: "ES", pt: "PT", de: "DE", nl: "NL", be: "BE",
  ch: "CH", it: "IT", at: "AT", se: "SE", no: "NO", fi: "FI", dk: "DK", is: "IS", pl: "PL",
  cz: "CZ", sk: "SK", hu: "HU", ro: "RO", bg: "BG", gr: "GR", hr: "HR", si: "SI", ee: "EE",
  lv: "LV", lt: "LT", ua: "UA", ru: "RU", tr: "TR", il: "IL", ae: "AE", sa: "SA", qa: "QA",
  eg: "EG", za: "ZA", ng: "NG", ke: "KE", gh: "GH", ma: "MA", in: "IN", pk: "PK", bd: "BD",
  lk: "LK", cn: "CN", hk: "HK", tw: "TW", jp: "JP", kr: "KR", sg: "SG", my: "MY", id: "ID",
  ph: "PH", th: "TH", vn: "VN", au: "AU", nz: "NZ", lu: "LU",
};

/** Extract the country name a scraper stashed in `notes` as `hq_country_name=...`. */
export function countryNameFromNotes(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const m = /hq_country_name\s*=\s*([^\n;|]+)/i.exec(notes);
  return m ? m[1].trim() || null : null;
}

/** ccTLD of a website/domain → ISO2, or null for generic/unknown TLDs. */
export function tldToIso2(websiteOrDomain: string | null | undefined): string | null {
  if (!websiteOrDomain) return null;
  let host = String(websiteOrDomain).trim().toLowerCase();
  if (!host) return null;
  try {
    if (host.includes("://")) host = new URL(host).hostname;
    else if (host.includes("/")) host = host.split("/")[0];
  } catch { /* fall through with raw host */ }
  host = host.replace(/^www\./, "").replace(/[:/].*$/, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  return TLD_TO_ISO2[tld] ?? null;
}

/** Resolve an ISO2 for one firm row using notes → region → TLD. Pure. */
export function resolveFirmIso2(row: {
  notes?: string | null;
  hq_region?: string | null;
  website?: string | null;
  domain?: string | null;
}): { iso2: string; source: "notes" | "region" | "tld" } | null {
  const fromNotes = parseCountryIso2(countryNameFromNotes(row.notes));
  if (fromNotes) return { iso2: fromNotes, source: "notes" };
  const fromRegion = parseCountryIso2(row.hq_region);
  if (fromRegion) return { iso2: fromRegion, source: "region" };
  const fromTld = tldToIso2(row.website) ?? tldToIso2(row.domain);
  if (fromTld) return { iso2: fromTld, source: "tld" };
  return null;
}

export interface GeoBackfillResult {
  scanned: number;
  resolved: number;
  unknown: number;
  bySource: { notes: number; region: number; tld: number };
}

interface FirmGeoRow {
  id: number;
  notes: string | null;
  hq_region: string | null;
  website: string | null;
  domain: string | null;
}

/**
 * Backfill `hq_country_iso2` for firms where it is NULL. Idempotent and
 * safe to re-run. `limit` caps the scan per invocation (default 1000) so a
 * nightly tick stays bounded; pass a large value for a one-shot full sweep.
 */
export async function runFirmGeoBackfill(
  env: Env,
  opts: { limit?: number } = {},
): Promise<GeoBackfillResult> {
  const limit = opts.limit ?? 1000;
  const res: GeoBackfillResult = {
    scanned: 0, resolved: 0, unknown: 0, bySource: { notes: 0, region: 0, tld: 0 },
  };
  const rows = await env.DB.prepare(
    `SELECT id, notes, hq_region, website, domain
       FROM firms
      WHERE hq_country_iso2 IS NULL OR hq_country_iso2 = ''
      ORDER BY id
      LIMIT ?`,
  ).bind(limit).all<FirmGeoRow>();
  for (const row of rows.results ?? []) {
    res.scanned += 1;
    const hit = resolveFirmIso2(row);
    if (!hit) { res.unknown += 1; continue; }
    await env.DB.prepare(
      `UPDATE firms SET hq_country_iso2 = ?, last_modified = ?
         WHERE id = ? AND (hq_country_iso2 IS NULL OR hq_country_iso2 = '')`,
    ).bind(hit.iso2, new Date().toISOString(), row.id).run();
    res.resolved += 1;
    res.bySource[hit.source] += 1;
  }
  return res;
}
