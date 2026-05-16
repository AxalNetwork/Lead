import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, importKey, type AggregatorHints } from "./_base";

/**
 * Golden Egg Check (goldeneggcheck.com) — Dutch VC directory.
 *
 * Investor cards live at /en/venture-capital-investors. Each card
 * carries firm name + a website link plus country/stage chips. We
 * respect any "Country" chip the card exposes, but default to NL when
 * the chip is missing (Golden Egg Check is a Netherlands-first
 * directory).
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  // Country only defaults to NL; explicit hints from the source
  // registry win.
  const mergedHints: AggregatorHints = {
    ...(hints ?? {}),
    country_iso2: hints?.country_iso2 ?? "NL",
  };

  await awaitHostSlot(env, url);
  const fetched = await fetchPage(env, url);
  if (!fetched.ok) {
    return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  }

  const html = fetched.html;
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];

  // Investor cards: <div class="...investor-card..."> ... <a href="..."> Firm </a> </div>
  const cardRe = /<(?:div|article|li)\b[^>]*class=["'][^"']*(?:investor[-_]card|investor|fund[-_]card|investor[-_]item)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|article|li)>/gi;
  let m: RegExpExecArray | null;
  while ((m = cardRe.exec(html)) !== null) {
    const block = m[1];
    const anchors = extractAnchors(block, url);
    const ext = anchors.find((a) =>
      /^https?:\/\//i.test(a.href)
      && !/goldeneggcheck\./i.test(a.href)
      && !/(linkedin|twitter|x\.com|facebook)/i.test(a.href),
    );
    if (!ext) continue;
    const text = decodeEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    const name = (ext.text || text.split(/[•·\|]/)[0] || "").trim();
    if (!name || name.length < 2 || name.length > 120) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    // Look for a Country: chip — falls back to NL via the merged hint.
    const countryHit = block.match(/country[^<:]{0,4}[:\s]*([A-Za-z .,()-]{2,32})/i);
    const stageChips = [...block.matchAll(/stage[^<:]{0,4}[:\s]*([A-Za-z\s-]{3,40})/gi)].map((mm) => mm[1].trim());

    const row: Record<string, unknown> = { name, website: ext.href };
    if (countryHit) row.country = countryHit[1].trim();
    if (stageChips.length) row.stages = stageChips.join(",");

    const cand = rowToCandidate(row, url);
    if (!cand) continue;
    (cand.candidate as { import_key?: string }).import_key = importKey("goldeneggcheck", name);
    firms.push(cand.candidate);
  }

  // Fallback: scan generic anchors when the card class pattern misses
  // entirely (Webflow re-themes sometimes drop the `investor-card`
  // class). Reject internal nav links by checking the href is external.
  if (!firms.length) {
    const anchors = extractAnchors(html, url);
    for (const a of anchors) {
      if (!/^https?:\/\//i.test(a.href)) continue;
      if (/goldeneggcheck\.|linkedin|twitter|x\.com|facebook|youtube/i.test(a.href)) continue;
      const name = decodeEntities(a.text || "").trim();
      if (!name || name.length < 2 || name.length > 80) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const cand = rowToCandidate({ name, website: a.href }, url);
      if (!cand) continue;
      (cand.candidate as { import_key?: string }).import_key = importKey("goldeneggcheck", name);
      firms.push(cand.candidate);
    }
  }

  for (const f of firms) applyHints(f, mergedHints);
  return { firms, totalSeen: seen.size };
}
