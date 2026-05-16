import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { extractAnchors } from "../../html";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { importFirms as importGenericCsv } from "./generic_csv_url";
import { importFirms as importNyc } from "./nyc_founder_guide";

/**
 * VersatileVC list importer.
 *
 * VersatileVC publishes investor lists as either: (a) an embedded Google
 * Sheet, (b) a downloadable CSV linked from the page, or (c) inline tables.
 * Strategy:
 *   1. Plain fetch the page.
 *   2. Find any `.csv` / `.tsv` link → defer to generic_csv_url.
 *   3. Otherwise treat the page like nyc_founder_guide (heading + anchor).
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const fetched = await fetchPage(env, url);
  if (!fetched.ok) return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };

  const anchors = extractAnchors(fetched.html, url);
  // Task #2: always collect downloadable file links (PDF / XLSX /
  // Google-Sheet) on the page and enqueue them as child URL jobs —
  // even when a CSV is also present. VersatileVC's `/free` page
  // typically lists multiple downloadable resources alongside the
  // primary CSV.
  const childUrls: string[] = [];
  for (const a of anchors) {
    if (/\.(pdf|xlsx?|ods)(\?|#|$)/i.test(a.href)) childUrls.push(a.href);
    else if (/docs\.google\.com\/spreadsheets\//i.test(a.href)) childUrls.push(a.href);
  }
  const dedupedChildren = [...new Set(childUrls)];

  const csvLink = anchors.find((a) => /\.(csv|tsv)(\?|#|$)/i.test(a.href));
  if (csvLink) {
    const r = await importGenericCsv(csvLink.href, env);
    // Stamp the page URL as the source so re-runs from the page URL still
    // dedupe correctly with re-runs from the underlying CSV URL.
    const firms: FirmCandidate[] = r.firms.map((f) => ({ ...f, source_url: url }));
    return {
      firms,
      totalSeen: r.totalSeen,
      errors: r.errors,
      childUrls: dedupedChildren.length ? dedupedChildren : undefined,
    };
  }

  // Fallback: page-as-list scrape using the same heuristics as the NYC guide.
  const fallback = await importNyc(url, env);
  if (dedupedChildren.length) {
    fallback.childUrls = [...new Set([...(fallback.childUrls ?? []), ...dedupedChildren])];
  }
  return fallback;
}
