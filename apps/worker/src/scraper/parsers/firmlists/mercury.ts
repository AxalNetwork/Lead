import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities } from "../../html";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { deriveDomain, rowToCandidate } from "./_helpers";

/**
 * Mercury Investor Database (mercury.com/investor-database) importer.
 *
 * The page is an SPA — a Browser Rendered fetch waits until network idle so
 * the React tree is fully hydrated. We then walk the rendered HTML for
 * investor cards (`a[href*="/investor/"]`-like anchors) plus any visible
 * meta the card surfaces (stage, check size, geography).
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  // Mercury paginates the investor list with a `?page=N` query param. We
  // walk pages until either an empty result page comes back, the same
  // anchor set repeats, or we hit a 30-page safety cap (~3000 firms).
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const errors: string[] = [];
  const MAX_PAGES = 30;
  let totalRowsSeen = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const pageUrl = appendPageParam(url, page);
    const fetched = await fetchPage(env, pageUrl, { forceBrowser: true });
    if (!fetched.ok) {
      errors.push(`page_${page}_fetch_failed:${fetched.blockReason ?? "unknown"}`);
      if (page === 1) return { firms: [], totalSeen: 0, errors };
      break;
    }
    const before = seen.size;
    extractCards(fetched.html, pageUrl, seen, firms);
    totalRowsSeen += seen.size - before;
    if (seen.size === before) {
      // No new firms on this page — assume we've walked off the end.
      if (page === 1 && !firms.length) {
        // Page 1 yielded nothing — try JSON-LD fallback before bailing.
        const jsonLd = scanJsonLd(fetched.html);
        for (const r of jsonLd) {
          const c = rowToCandidate(r, pageUrl);
          if (c) firms.push(c.candidate);
        }
        return { firms, totalSeen: jsonLd.length, errors };
      }
      break;
    }
  }

  for (const f of firms) {
    if (!f.domain && f.website) f.domain = deriveDomain(f.website);
  }
  return { firms, totalSeen: totalRowsSeen, errors };
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
  const cardRe = /<a\b[^>]*href="([^"]*\/investor-database\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null) {
    const href = m[1];
    const inner = m[2];
    if (seen.has(href)) continue;
    seen.add(href);
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!text) continue;
    // Try to split "Name • $check • Stage • Geo" style strings if Mercury
    // surfaces them; otherwise just take the first segment as the name.
    const parts = text.split(/[•·\|]/).map((s) => s.trim()).filter(Boolean);
    const name = parts[0];
    if (!name) continue;
    const row: Record<string, unknown> = { name };
    if (parts[1]) row["check"] = parts[1];
    if (parts[2]) row["stage"] = parts[2];
    if (parts[3]) row["geo"] = parts[3];
    const cand = rowToCandidate(row, pageUrl);
    if (cand) {
      const slug = href.split("/").filter(Boolean).pop() ?? "";
      cand.candidate.openvc_url = null;
      cand.candidate.notes = (cand.candidate.notes ? cand.candidate.notes + "\n" : "") + `mercury_slug: ${slug}`;
      // Card source URL — keep absolute, falls back to relative against the page.
      try {
        cand.candidate.source_url = new URL(href, pageUrl).toString();
      } catch {
        cand.candidate.source_url = pageUrl;
      }
      firms.push(cand.candidate);
    }
  }
}

function scanJsonLd(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    try {
      const blob = JSON.parse(decodeEntities(m[1]));
      const items = collectListItems(blob);
      for (const it of items) out.push({ name: typeof it === "string" ? it : (it as { name?: string }).name ?? "" });
    } catch {
      // ignore
    }
  }
  return out.filter((r) => r.name);
}

function collectListItems(blob: unknown): unknown[] {
  if (!blob) return [];
  if (Array.isArray(blob)) return blob.flatMap(collectListItems);
  if (typeof blob !== "object") return [];
  const o = blob as Record<string, unknown>;
  if (Array.isArray(o.itemListElement)) {
    return (o.itemListElement as unknown[]).map((e) => {
      const item = (e as { item?: unknown }).item ?? e;
      return item;
    });
  }
  return Object.values(o).flatMap(collectListItems);
}
