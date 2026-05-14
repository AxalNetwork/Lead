import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities } from "../../html";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { rowToCandidate } from "./_helpers";

/**
 * Generic last-resort importer: parses any `<script type="application/ld+json">`
 * blocks for ItemList schemas, treating each item as a firm candidate.
 *
 * Many static "list of investors" pages embed an ItemList for SEO; this
 * importer is the safest fallback when no per-source importer matches.
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const fetched = await fetchPage(env, url);
  if (!fetched.ok) return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  const blocks = scanLdBlocks(fetched.html);
  const records: Array<Record<string, unknown>> = [];
  for (const blob of blocks) collectItems(blob, records);
  const firms: FirmCandidate[] = [];
  for (const r of records) {
    const cand = rowToCandidate(r, url);
    if (cand) firms.push(cand.candidate);
  }
  return { firms, totalSeen: records.length };
}

function scanLdBlocks(html: string): unknown[] {
  const out: unknown[] = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      out.push(JSON.parse(decodeEntities(m[1])));
    } catch {
      // Skip malformed blocks rather than aborting the whole importer.
    }
  }
  return out;
}

function collectItems(blob: unknown, sink: Array<Record<string, unknown>>): void {
  if (!blob) return;
  if (Array.isArray(blob)) {
    for (const e of blob) collectItems(e, sink);
    return;
  }
  if (typeof blob !== "object") return;
  const o = blob as Record<string, unknown>;
  const t = String(o["@type"] ?? "").toLowerCase();
  if (t === "itemlist" && Array.isArray(o.itemListElement)) {
    for (const el of o.itemListElement) {
      const item = (el as { item?: unknown }).item ?? el;
      if (item && typeof item === "object") {
        const r = item as Record<string, unknown>;
        const row: Record<string, unknown> = {
          name: r.name ?? r.headline,
          website: r.url ?? r.sameAs,
          thesis: r.description,
        };
        sink.push(row);
      }
    }
    return;
  }
  if (t === "organization" || t === "corporation" || t === "ngo") {
    sink.push({
      name: o.name,
      website: o.url,
      thesis: o.description,
      LinkedIn: pickSameAs(o.sameAs, /linkedin/i),
      Twitter: pickSameAs(o.sameAs, /(twitter|x)\.com/i),
    });
  }
  // Recurse: ItemList may live inside @graph etc.
  for (const v of Object.values(o)) {
    if (v && typeof v === "object") collectItems(v, sink);
  }
}

function pickSameAs(value: unknown, pat: RegExp): string | null {
  if (!value) return null;
  const arr = Array.isArray(value) ? value : [value];
  for (const v of arr) if (typeof v === "string" && pat.test(v)) return v;
  return null;
}
