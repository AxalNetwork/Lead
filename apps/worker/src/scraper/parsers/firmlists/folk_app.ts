import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities } from "../../html";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { rowToCandidate } from "./_helpers";

/**
 * Folk app share-link importer (folk.app shared lists).
 *
 * Folk's share viewer is an SPA that hydrates by calling
 * `https://app.folk.app/api/share/<shareId>` (or similar). We:
 *   1. Browser-render the page so the share data hydrates into HTML.
 *   2. Look for an inline JSON blob under `<script id="__NEXT_DATA__">`
 *      (Next.js) or a `window.__SHARE_DATA__` assignment.
 *   3. Walk it for arrays of contact records (folk's people share lists)
 *      and treat each `org` as a firm candidate.
 *
 * If neither blob is present we fall back to anchor-based name extraction.
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const fetched = await fetchPage(env, url, { forceBrowser: true });
  if (!fetched.ok) return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };

  const blob = extractInlineJson(fetched.html);
  if (blob) {
    const records = collectRecords(blob);
    if (records.length) {
      const firms: FirmCandidate[] = [];
      for (const r of records) {
        const cand = rowToCandidate(toRow(r), url);
        if (cand) firms.push(cand.candidate);
      }
      return { firms, totalSeen: records.length };
    }
  }

  // Fallback: anchor scan for `<a>` tags whose text looks like a firm name
  // and href points to an external website.
  const firms: FirmCandidate[] = [];
  const anchorRe = /<a\b[^>]*href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(fetched.html)) !== null) {
    const href = m[1];
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!text || text.length < 2 || text.length > 80) continue;
    if (seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    const cand = rowToCandidate({ name: text, website: href }, url);
    if (cand) firms.push(cand.candidate);
  }
  return { firms, totalSeen: seen.size };
}

function extractInlineJson(html: string): unknown | null {
  const next = html.match(/<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/);
  if (next) {
    try { return JSON.parse(decodeEntities(next[1])); } catch { /* fall through */ }
  }
  const winShare = html.match(/window\.__SHARE_DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (winShare) {
    try { return JSON.parse(decodeEntities(winShare[1])); } catch { /* fall through */ }
  }
  return null;
}

interface FolkRecord {
  name?: string;
  organization?: string;
  org?: string;
  company?: string;
  website?: string;
  domain?: string;
  email?: string;
  linkedin?: string;
  city?: string;
  country?: string;
  [k: string]: unknown;
}

function collectRecords(blob: unknown): FolkRecord[] {
  const out: FolkRecord[] = [];
  const stack: unknown[] = [blob];
  const seen = new WeakSet<object>();
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur as object)) continue;
    seen.add(cur as object);
    if (Array.isArray(cur)) {
      if (cur.length && cur.every((e) => looksLikeRecord(e))) {
        for (const e of cur) out.push(e as FolkRecord);
        continue;
      }
      for (const e of cur) stack.push(e);
    } else {
      for (const v of Object.values(cur as Record<string, unknown>)) stack.push(v);
    }
  }
  return out;
}

function looksLikeRecord(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  const hasName = ["name", "organization", "org", "company"].some((k) => typeof o[k] === "string");
  if (!hasName) return false;
  return ["website", "domain", "email", "linkedin"].some((k) => typeof o[k] === "string");
}

function toRow(r: FolkRecord): Record<string, unknown> {
  return {
    name: r.organization ?? r.org ?? r.company ?? r.name,
    website: r.website,
    domain: r.domain,
    email: r.email,
    LinkedIn: r.linkedin,
    City: r.city,
    Country: r.country,
  };
}
