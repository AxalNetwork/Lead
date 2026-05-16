import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, detectSignupWall, importKey, pageBudget, type AggregatorHints } from "./_base";

/**
 * VCSheet (vcsheet.com) importer.
 *
 * VCSheet publishes investor directories as Webflow / Notion-rendered
 * pages. Each fund is exposed as a card containing the firm name + a
 * link to a detail page (often /funds/{slug}). Some surfaces require
 * a free account; this importer detects the wall and surfaces a
 * `signup_required` warning instead of returning empty.
 *
 * Strategy:
 *   1. Browser-render the page (Webflow ships server-rendered HTML but
 *      filter panes hydrate client-side).
 *   2. Pull every `<a href="/funds/...">` card and its visible name.
 *   3. Fall back to JSON-LD ItemList scanning.
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const errors: string[] = [];
  const MAX_PAGES = pageBudget(env, "vcsheet", 8);
  let totalSeen = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = appendPageParam(url, page);
    await awaitHostSlot(env, pageUrl);
    const fetched = await fetchPage(env, pageUrl, { forceBrowser: true });
    if (!fetched.ok) {
      errors.push(`page_${page}_fetch_failed:${fetched.blockReason ?? "unknown"}`);
      if (page === 1) return { firms: [], totalSeen: 0, errors };
      break;
    }
    const wall = detectSignupWall(fetched.html, pageUrl);
    if (wall) errors.push(wall);
    const before = seen.size;
    extractCards(fetched.html, pageUrl, seen, firms);
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
  } catch {
    return url + (url.includes("?") ? "&" : "?") + `page=${page}`;
  }
}

function extractCards(html: string, pageUrl: string, seen: Set<string>, firms: FirmCandidate[]): void {
  const cardRe = /<a\b[^>]*href=["']([^"']*\/(?:funds|fund|investors|investor)\/[^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null) {
    const href = m[1];
    const inner = m[2];
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!text || text.length < 2 || text.length > 120) continue;
    const name = text.split(/[•·\|]/)[0].trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = rowToCandidate({ name }, pageUrl);
    if (!cand) continue;
    try { cand.candidate.source_url = new URL(href, pageUrl).toString(); }
    catch { cand.candidate.source_url = pageUrl; }
    (cand.candidate as { import_key?: string }).import_key = importKey("vcsheet", name);
    firms.push(cand.candidate);
  }

  // Fallback: bullet-list anchors when the cards regex misses.
  if (!firms.length) {
    const anchors = extractAnchors(html, pageUrl);
    for (const a of anchors) {
      if (!/\/(funds?|investors?)\//i.test(a.href)) continue;
      const name = decodeEntities(a.text || "").trim();
      if (!name || name.length < 2 || name.length > 120) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const cand = rowToCandidate({ name }, pageUrl);
      if (!cand) continue;
      cand.candidate.source_url = a.href;
      (cand.candidate as { import_key?: string }).import_key = importKey("vcsheet", name);
      firms.push(cand.candidate);
    }
  }
}
