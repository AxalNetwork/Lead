import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities, extractAnchors } from "../../html";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { rowToCandidate } from "./_helpers";
import { importKey } from "./aggregators/_base";

/** Task #2: every firm scraped from the NYC Founder Guide is force-
 *  tagged with `geo:nyc_metro` so the dashboard's NYC filter finds
 *  them even when the row itself doesn't carry a city. The tag taxonomy
 *  uses single-colon prefixes consumed by `mapTagTaxonomy` in the
 *  pipeline (`geo` is one of the accepted prefixes; `geo_metro` is not). */
const NYC_TAG = "geo:nyc_metro";

/**
 * NYC Founder Guide investor list (or any wiki/Notion-style listing where
 * each firm is a heading + adjacent metadata block) importer.
 *
 * Strategy: plain HTML fetch (no JS hydration needed for static guide pages),
 * then walk every `<h2>` / `<h3>` / `<li>` whose text looks like a firm name
 * and pair it with the first outbound anchor that follows.
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const fetched = await fetchPage(env, url);
  if (!fetched.ok) return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };

  // Parse heading entries first; falls back to bullet list anchors.
  const html = fetched.html;
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];

  // Pattern: <hN>Name</hN> ... <a href="https://firm.com">…</a>
  const headingRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>([\s\S]*?)(?=<h[2-4][^>]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    const name = decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!name || name.length < 2 || name.length > 80) continue;
    const block = m[2];
    const anchors = extractAnchors(block, url);
    const ext = anchors.find((a) => /^https?:\/\//i.test(a.href) && !/(linkedin|twitter|x\.com|crunchbase)/i.test(a.href));
    const linkedin = anchors.find((a) => /linkedin\.com/i.test(a.href))?.href;
    const twitter = anchors.find((a) => /(twitter|x)\.com/i.test(a.href))?.href;
    const description = decodeEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 500);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = rowToCandidate({
      name,
      website: ext?.href,
      thesis: description || null,
      LinkedIn: linkedin,
      Twitter: twitter,
    }, url);
    if (cand) {
      (cand.candidate as { import_key?: string }).import_key = importKey("nyc_fg", name);
      (cand.candidate as { tags?: string[] }).tags = [NYC_TAG];
      firms.push(cand.candidate);
    }
  }

  // Bullet-list fallback: <li><a href="https://firm.com">Firm Name</a> – blurb</li>
  if (!firms.length) {
    const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
    while ((m = liRe.exec(html)) !== null) {
      const anchors = extractAnchors(m[1], url);
      const ext = anchors.find((a) => /^https?:\/\//i.test(a.href) && !/(linkedin|twitter|x\.com)/i.test(a.href));
      if (!ext) continue;
      const text = decodeEntities(ext.text || m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
      const name = text.split("–")[0].split("-")[0].trim();
      if (!name || seen.has(name.toLowerCase())) continue;
      seen.add(name.toLowerCase());
      const cand = rowToCandidate({ name, website: ext.href }, url);
      if (cand) {
        (cand.candidate as { import_key?: string }).import_key = importKey("nyc_fg", name);
        (cand.candidate as { tags?: string[] }).tags = [NYC_TAG];
        firms.push(cand.candidate);
      }
    }
  }

  return { firms, totalSeen: seen.size };
}
