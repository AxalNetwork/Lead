import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, detectSignupWall, importKey, pageBudget, type AggregatorHints } from "./_base";

/**
 * landscape.vc importer.
 *
 * landscape.vc is a Next.js directory; the first reliable extraction
 * path is the inline `__NEXT_DATA__` JSON, which carries arrays of
 * fund records under page props. Pagination is via `?page=N`.
 *
 * Strategy:
 *   1. Browser-render to ensure __NEXT_DATA__ is present.
 *   2. BFS for arrays whose elements look like investor records.
 *   3. Fallback: anchor scan for `/funds/{slug}` links.
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const errors: string[] = [];
  const MAX_PAGES = pageBudget(env, "landscape_vc", 10);
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
    const data = extractNextData(fetched.html);
    let added = 0;
    if (data) {
      const records = harvestInvestors(data);
      totalSeen += records.length;
      for (const r of records) {
        const name = (r.name || "").trim();
        const key = name.toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        const cand = rowToCandidate(toRow(r), pageUrl);
        if (!cand) continue;
        (cand.candidate as { import_key?: string }).import_key = importKey("landscape_vc", name);
        // Task #2: preserve the landscape.vc sector taxonomy as
        // `sector:{slug}` tags so the pipeline writes them to
        // `entity_tags`. Stage tags surfaced similarly.
        const tags: string[] = [];
        const sectors = Array.isArray(r.sectors) ? r.sectors : (typeof r.sectors === "string" ? r.sectors.split(/[,;]/) : []);
        for (const s of sectors) {
          const slug = String(s).trim().toLowerCase().replace(/\s+/g, "_");
          if (slug) tags.push(`sector:${slug}`);
        }
        const stages = Array.isArray(r.stages) ? r.stages : (typeof r.stages === "string" ? r.stages.split(/[,;]/) : []);
        for (const s of stages) {
          const slug = String(s).trim().toLowerCase().replace(/\s+/g, "_");
          if (slug) tags.push(`stage:${slug}`);
        }
        if (typeof r.type === "string" && r.type.trim()) tags.push(`role:${r.type.toLowerCase().replace(/\s+/g, "_")}`);
        if (tags.length) (cand.candidate as { tags?: string[] }).tags = tags;
        firms.push(cand.candidate);
        added += 1;
      }
    } else if (page === 1) {
      errors.push("next_data_missing");
    }
    if (added === 0) break;
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

function extractNextData(html: string): unknown | null {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(decodeEntities(m[1])); } catch { return null; }
}

interface LandscapeRecord {
  name?: string;
  website?: string;
  url?: string;
  description?: string;
  thesis?: string;
  hq?: string;
  city?: string;
  country?: string;
  stages?: string[] | string;
  sectors?: string[] | string;
  type?: string;
  [k: string]: unknown;
}

function harvestInvestors(blob: unknown): LandscapeRecord[] {
  const out: LandscapeRecord[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [blob];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);
    if (Array.isArray(cur)) {
      if (cur.length && cur.every((e) => looksLikeInvestor(e))) {
        for (const e of cur) out.push(e as LandscapeRecord);
        continue;
      }
      for (const e of cur) stack.push(e);
    } else {
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
    }
  }
  return out;
}

function looksLikeInvestor(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name.trim()) return false;
  return ["thesis", "description", "stages", "sectors", "hq", "city", "website", "url", "type"]
    .some((k) => k in o);
}

function toRow(r: LandscapeRecord): Record<string, unknown> {
  return {
    name: r.name,
    website: r.website ?? r.url,
    thesis: r.thesis ?? r.description ?? null,
    stages: r.stages,
    sectors: r.sectors,
    City: r.city ?? r.hq,
    Country: r.country,
    Type: r.type,
  };
}
