import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, detectSignupWall, importKey, pageBudget, type AggregatorHints } from "./_base";

/**
 * Climatescape (climatescape.org) importer.
 *
 * Climatescape is a community-edited directory of climate companies
 * and investors. Investor lists live at `/investors` and detail rows
 * link to `/organizations/{slug}`.
 *
 * Every firm surfaced by this importer is force-tagged `sector:climate`
 * (in addition to any hint-supplied tags) so the dashboard's climate
 * filter always finds Climatescape-sourced rows.
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  // Force climate sector unconditionally — operators can't override it
  // (every firm on climatescape is climate-tech by definition).
  const mergedHints: AggregatorHints = { ...(hints ?? {}), sector: "climate" };
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const errors: string[] = [];
  const MAX_PAGES = pageBudget(env, "climatescape", 8);
  let totalSeen = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = appendPageParam(url, page);
    await awaitHostSlot(env, pageUrl);
    const fetched = await fetchPage(env, pageUrl);
    if (!fetched.ok) {
      errors.push(`page_${page}_fetch_failed:${fetched.blockReason ?? "unknown"}`);
      if (page === 1) return { firms: [], totalSeen: 0, errors };
      break;
    }
    const wall = detectSignupWall(fetched.html, pageUrl);
    if (wall) errors.push(wall);
    const before = seen.size;
    extractRows(fetched.html, pageUrl, seen, firms);
    totalSeen += seen.size - before;
    if (seen.size === before) break;
  }

  for (const f of firms) applyHints(f, mergedHints);
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
  // Pattern 1: anchors pointing to /organizations/{slug}
  const orgRe = /<a\b[^>]*href=["']([^"']*\/organizations\/[^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = orgRe.exec(html)) !== null) {
    const href = m[1];
    const inner = m[2];
    const name = decodeEntities(inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!name || name.length < 2 || name.length > 120) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = rowToCandidate({ name }, pageUrl);
    if (!cand) continue;
    try { cand.candidate.source_url = new URL(href, pageUrl).toString(); }
    catch { cand.candidate.source_url = pageUrl; }
    (cand.candidate as { import_key?: string }).import_key = importKey("climatescape", name);
    firms.push(cand.candidate);
  }

  // Pattern 2: fallback to any anchor with an external href inside a list.
  if (!firms.length) {
    const anchors = extractAnchors(html, pageUrl);
    for (const a of anchors) {
      if (!/^https?:\/\//i.test(a.href)) continue;
      if (/(climatescape\.org|linkedin|twitter|x\.com|facebook)/i.test(a.href)) continue;
      const name = decodeEntities(a.text || "").trim();
      if (!name || name.length < 2 || name.length > 80) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const cand = rowToCandidate({ name, website: a.href }, pageUrl);
      if (!cand) continue;
      (cand.candidate as { import_key?: string }).import_key = importKey("climatescape", name);
      firms.push(cand.candidate);
    }
  }
}
