import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, detectSignupWall, importKey, type AggregatorHints } from "./_base";

/**
 * Failory (failory.com) startup / investor lists importer.
 *
 * Failory publishes long-form posts shaped as numbered lists:
 *   <h3>1. Firm Name</h3>
 *   <p>… website / description …</p>
 * The first outbound anchor in the paragraph block is the firm site.
 *
 * Strategy:
 *   1. Plain HTML fetch.
 *   2. Walk every `<h2>`/`<h3>` whose text starts with `N.` or
 *      `N) `, strip the prefix, and pair with the first external
 *      anchor in the following sibling block (until the next heading).
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  await awaitHostSlot(env, url);
  const fetched = await fetchPage(env, url);
  if (!fetched.ok) return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  const errors: string[] = [];
  const wall = detectSignupWall(fetched.html, url);
  if (wall) errors.push(wall);

  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const html = fetched.html;

  const headingRe = /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>([\s\S]*?)(?=<h[2-4][^>]|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(html)) !== null) {
    const rawHeading = decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const name = stripNumericPrefix(rawHeading);
    if (!name || name.length < 2 || name.length > 80) continue;
    if (/^(table of contents|conclusion|summary|introduction|frequently)/i.test(name)) continue;
    const block = m[2];
    const anchors = extractAnchors(block, url);
    const ext = anchors.find((a) =>
      /^https?:\/\//i.test(a.href)
      && !/(linkedin|twitter|x\.com|youtube|facebook|crunchbase|failory\.)/i.test(a.href),
    );
    const linkedin = anchors.find((a) => /linkedin\.com/i.test(a.href))?.href;
    const description = decodeEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 500);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = rowToCandidate({
      name,
      website: ext?.href,
      thesis: description || null,
      LinkedIn: linkedin,
    }, url);
    if (!cand) continue;
    (cand.candidate as { import_key?: string }).import_key = importKey("failory", name);
    firms.push(cand.candidate);
  }

  for (const f of firms) applyHints(f, hints);
  return { firms, totalSeen: seen.size, errors: errors.length ? errors : undefined };
}

function stripNumericPrefix(s: string): string {
  return s.replace(/^\s*(?:#\d+|\d+[.):\-])\s*/, "").trim();
}
