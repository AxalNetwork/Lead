import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, importKey, type AggregatorHints } from "./_base";

/**
 * JVCA (jvca.jp) — Japan Venture Capital Association member directory.
 *
 * The public list lives at /members/vc-members. Each row carries the
 * Japanese firm name + a romanized (latin) alias + a website link.
 * Every emitted firm is force-tagged `country:JP` and `lang:ja` so the
 * dashboard's Japan filter always finds JVCA-sourced rows. Per the
 * Task #3 spec each firm's website is also surfaced as a `childUrls`
 * entry so the pipeline enqueues a `kind='url'` job for team discovery.
 */
export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  // Force country/lang regardless of caller hints — JVCA membership is
  // by definition Japanese.
  const mergedHints: AggregatorHints = { ...(hints ?? {}), country_iso2: "JP" };

  await awaitHostSlot(env, url);
  const fetched = await fetchPage(env, url);
  if (!fetched.ok) {
    return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  }

  const html = fetched.html;
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const childUrls = new Set<string>();

  // Strategy 1: <tr>/<li> blocks containing an anchor to an external
  // site. JVCA's member table is laid out as <tr><td>JP name (Latin)</td>
  // <td><a href="firm site">link</a></td></tr>.
  const rowRe = /<(tr|li|article)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const block = m[2];
    const anchors = extractAnchors(block, url);
    const ext = anchors.find((a) =>
      /^https?:\/\//i.test(a.href)
      && !/jvca\.jp/i.test(a.href)
      && !/(twitter|x\.com|facebook|linkedin|instagram|youtube)/i.test(a.href),
    );
    if (!ext) continue;
    const text = decodeEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!text) continue;
    // Pull the first plausible firm-name token. JVCA rows look like:
    //   "株式会社グローバル・ブレイン Global Brain Corporation"
    // We keep both names: the leading run of non-latin chars is the
    // Japanese name; the trailing latin run is the romanized alias.
    const { jpName, romName } = splitJapaneseName(text);
    const name = romName || jpName;
    if (!name || name.length < 2 || name.length > 120) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const cand = rowToCandidate({
      name,
      legal_name: jpName && jpName !== name ? jpName : undefined,
      website: ext.href,
    }, url);
    if (!cand) continue;
    // Force the lang tag in addition to the hint-supplied tags.
    const tagSet = new Set<string>(Array.isArray((cand.candidate as { tags?: string[] }).tags) ? (cand.candidate as { tags?: string[] }).tags! : []);
    tagSet.add("lang:ja");
    (cand.candidate as { tags?: string[] }).tags = [...tagSet];
    (cand.candidate as { import_key?: string }).import_key = importKey("jvca", name);
    firms.push(cand.candidate);
    childUrls.add(ext.href);
  }

  for (const f of firms) applyHints(f, mergedHints);
  return {
    firms,
    totalSeen: seen.size,
    childUrls: [...childUrls],
  };
}

/**
 * Split "株式会社グローバル・ブレイン Global Brain Corporation" into
 * { jpName: "株式会社グローバル・ブレイン", romName: "Global Brain Corporation" }.
 * If only one script is present the other side is null.
 */
function splitJapaneseName(text: string): { jpName: string | null; romName: string | null } {
  const trimmed = text.trim();
  // eslint-disable-next-line no-control-regex -- ASCII boundary detector for JP/Roman script split
  const jp = trimmed.match(/^[^\x00-\x7F]+/);
  const rom = trimmed.match(/[A-Za-z][A-Za-z0-9 .,&'\-()]+/);
  return {
    jpName: jp ? jp[0].trim() : null,
    romName: rom ? rom[0].trim() : null,
  };
}
