import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, detectSignupWall, importKey, type AggregatorHints } from "./_base";

/**
 * Mountside Ventures (mountsideventures.com) investor database importer.
 *
 * The full database is gated behind a free signup (the public landing
 * page only previews a handful of firms). This importer:
 *   1. Fetches the public landing page.
 *   2. Surfaces a `signup_required` warning when the wall is detected
 *      so the operator knows the import was partial.
 *   3. Captures whatever public preview rows are visible (firm name +
 *      website / linkedin).
 *
 * Operators who want the full dataset should export a CSV from inside
 * Mountside and POST it to /api/import/csv.
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  await awaitHostSlot(env, url);
  const fetched = await fetchPage(env, url, { forceBrowser: true });
  if (!fetched.ok) {
    return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  }

  const errors: string[] = [];
  const wall = detectSignupWall(fetched.html, url);
  if (wall) {
    errors.push(wall);
    errors.push("mountside_full_dataset_requires_signup:use_csv_upload");
  }

  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const html = fetched.html;

  // Preview cards: <div class="investor-card"> Name <a href="…"> …
  // We accept any anchor pointing at an external (non-mountside) site
  // inside a `<li>` or card-like block.
  const blockRe = /<(?:li|article|div)\b[^>]*class=["'][^"']*(?:investor|card|fund|partner)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|article|div)>/gi;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const block = m[1];
    const anchors = extractAnchors(block, url);
    const ext = anchors.find((a) => /^https?:\/\//i.test(a.href) && !/mountsideventures\./i.test(a.href) && !/(linkedin|twitter|x\.com)/i.test(a.href));
    const linkedin = anchors.find((a) => /linkedin\.com/i.test(a.href))?.href;
    if (!ext && !linkedin) continue;
    const text = decodeEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const name = (text.split(/[•·\|]/)[0] || "").slice(0, 80).trim();
    if (!name || name.length < 2) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = rowToCandidate({
      name,
      website: ext?.href,
      LinkedIn: linkedin,
    }, url);
    if (!cand) continue;
    (cand.candidate as { import_key?: string }).import_key = importKey("mountside", name);
    firms.push(cand.candidate);
  }

  for (const f of firms) applyHints(f, hints);
  return { firms, totalSeen: seen.size, errors: errors.length ? errors : undefined };
}
