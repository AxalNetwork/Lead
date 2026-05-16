import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, detectSignupWall, importKey, pageBudget, type AggregatorHints } from "./_base";

/**
 * VCStack (vcstack.io / vcstack.com) importer.
 *
 * VCStack publishes a flat investor directory as a Next-style SSR
 * page. Each row is an `<li>` or table row with the firm name + a
 * link to the firm's website plus optional stage/sector chips.
 *
 * Strategy:
 *   1. Plain fetch (page is server-rendered).
 *   2. Walk `<tr>` / `<li>` rows; pair the first anchor (firm site)
 *      with the visible text label.
 *   3. Detect signup walls.
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const errors: string[] = [];
  const MAX_PAGES = pageBudget(env, "vcstack", 6);
  let totalSeen = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = appendPageParam(url, page);
    await awaitHostSlot(env, pageUrl);
    const fetched = await fetchPage(env, pageUrl);
    if (!fetched.ok) {
      errors.push(`page_${page}_fetch_failed:${fetched.blockReason ?? "unknown"}`);
      if (page === 1) {
        // Retry with browser rendering before giving up.
        const r2 = await fetchPage(env, pageUrl, { forceBrowser: true });
        if (!r2.ok) return { firms: [], totalSeen: 0, errors };
        const wall = detectSignupWall(r2.html, pageUrl);
        if (wall) errors.push(wall);
        const before = seen.size;
        extractRows(r2.html, pageUrl, seen, firms);
        totalSeen += seen.size - before;
        continue;
      }
      break;
    }
    const wall = detectSignupWall(fetched.html, pageUrl);
    if (wall) errors.push(wall);
    const before = seen.size;
    extractRows(fetched.html, pageUrl, seen, firms);
    totalSeen += seen.size - before;
    if (seen.size === before) break;
  }

  for (const f of firms) applyHints(f, hints);
  return { firms, totalSeen, errors };
}

function appendPageParam(url: string, page: number): string {
  if (page <= 1) return url;
  try {
    const u = new URL(url);
    u.searchParams.set("page", String(page));
    return u.toString();
  } catch { return url + (url.includes("?") ? "&" : "?") + `page=${page}`; }
}

function extractRows(html: string, pageUrl: string, seen: Set<string>, firms: FirmCandidate[]): void {
  // Try <tr> rows first (table layout), then <li> (list layout).
  const rowRe = /<(?:tr|li)\b[^>]*>([\s\S]*?)<\/(?:tr|li)>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const block = m[1];
    const anchors = extractAnchors(block, pageUrl);
    const ext = anchors.find((a) => /^https?:\/\//i.test(a.href) && !/(linkedin|twitter|x\.com|crunchbase|vcstack\.)/i.test(a.href));
    if (!ext) continue;
    const linkedin = anchors.find((a) => /linkedin\.com\/company/i.test(a.href))?.href;
    const twitter = anchors.find((a) => /(twitter|x)\.com/i.test(a.href))?.href;
    const text = decodeEntities(ext.text || block.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const name = text.split(/[•·\|–—]/)[0].trim();
    if (!name || name.length < 2 || name.length > 80) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = rowToCandidate({
      name,
      website: ext.href,
      LinkedIn: linkedin,
      Twitter: twitter,
    }, pageUrl);
    if (!cand) continue;
    (cand.candidate as { import_key?: string }).import_key = importKey("vcstack", name);
    firms.push(cand.candidate);
  }
}
