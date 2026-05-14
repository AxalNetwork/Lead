import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities } from "../../html";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { rowToCandidate } from "./_helpers";

/**
 * OpenVC importer (openvc.app investor list pages).
 *
 * OpenVC is a Next.js app, so the simplest reliable extraction path is:
 *   1. Browser-render the page and parse the inline `__NEXT_DATA__` JSON.
 *   2. Walk the JSON to find arrays of investor records.
 *
 * Pagination: callers can pass `?page=N` in the URL. The importer pulls only
 * the requested page (the route layer iterates externally if needed).
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const fetched = await fetchPage(env, url, { forceBrowser: true });
  if (!fetched.ok) return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };

  const data = extractNextData(fetched.html);
  if (!data) return { firms: [], totalSeen: 0, errors: ["next_data_missing"] };

  const records = harvestInvestors(data);
  const firms: FirmCandidate[] = [];
  for (const r of records) {
    const cand = rowToCandidate(toRow(r), url);
    if (cand) firms.push(cand.candidate);
  }
  return { firms, totalSeen: records.length };
}

function extractNextData(html: string): unknown | null {
  const m = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    return JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
}

interface OpenVcInvestor {
  name?: string;
  website?: string;
  thesis?: string;
  description?: string;
  hq_city?: string;
  hq_country?: string;
  stages?: string[] | string;
  sectors?: string[] | string;
  industries?: string[] | string;
  check_size_min?: number | string;
  check_size_max?: number | string;
  ticket_min?: number | string;
  ticket_max?: number | string;
  linkedin?: string;
  twitter?: string;
  type?: string;
  [k: string]: unknown;
}

function harvestInvestors(blob: unknown): OpenVcInvestor[] {
  // BFS for arrays whose elements look like investor records.
  const out: OpenVcInvestor[] = [];
  const seen = new WeakSet<object>();
  const stack: unknown[] = [blob];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);
    if (Array.isArray(cur)) {
      if (cur.length && cur.every((e) => looksLikeInvestor(e))) {
        for (const e of cur) out.push(e as OpenVcInvestor);
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
  // Lean heuristic: presence of any investor-shaped field.
  return [
    "thesis", "description", "stages", "stage", "sectors", "industries",
    "ticket_min", "ticket_max", "check_size_min", "check_size_max",
    "hq_city", "hq_country", "website", "linkedin",
  ].some((k) => k in o);
}

function toRow(r: OpenVcInvestor): Record<string, unknown> {
  const row: Record<string, unknown> = {
    name: r.name,
    website: r.website,
    thesis: r.thesis ?? r.description ?? null,
    stages: r.stages,
    sectors: r.sectors ?? r.industries,
    "Check Size Min": r.check_size_min ?? r.ticket_min,
    "Check Size Max": r.check_size_max ?? r.ticket_max,
    City: r.hq_city,
    Country: r.hq_country,
    LinkedIn: r.linkedin,
    Twitter: r.twitter,
    Type: r.type,
  };
  return row;
}
