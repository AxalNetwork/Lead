import type { Env } from "../../../../types";
import { fetchPage } from "../../../fetcher";
import { decodeEntities, extractAnchors } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate } from "../_helpers";
import { applyHints, awaitHostSlot, detectSignupWall, importKey, type AggregatorHints } from "./_base";

/**
 * Founders Next Move (foundersnextmove.com) importer.
 *
 * Founders Next Move publishes 8 sub-directories under
 * /investors/{category} (accelerators, government funds, impact funds,
 * corporate VCs, etc.). Each page is a static HTML list; rows are
 * `<li>` or `<tr>` items with the firm name + outbound site link.
 *
 * The importer auto-detects which category the URL is for and stamps a
 * `role:{slug}` tag on every firm so downstream filters can split the
 * data by program type. Hints (passed by the operator) take precedence
 * over the URL-derived default.
 */
const ROLE_BY_SLUG: Record<string, string> = {
  "accelerators": "accelerator",
  "accelerator": "accelerator",
  "incubators": "incubator",
  "incubator": "incubator",
  "government-funds": "gov_fund",
  "government": "gov_fund",
  "grants": "grant_program",
  "impact-funds": "impact_fund",
  "impact": "impact_fund",
  "corporate-vcs": "corp_vc",
  "corporate": "corp_vc",
  "venture-studios": "venture_studio",
  "studios": "venture_studio",
  "angels": "angel",
  "angel-investors": "angel",
  "syndicates": "syndicate",
  "fellowships": "fellowship",
  "fellows": "fellowship",
  "competitions": "competition",
};

export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  await awaitHostSlot(env, url);
  const fetched = await fetchPage(env, url);
  if (!fetched.ok) return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  const errors: string[] = [];
  const wall = detectSignupWall(fetched.html, url);
  if (wall) errors.push(wall);

  const derivedRole = deriveRoleFromUrl(url);
  const mergedHints: AggregatorHints = {
    ...(hints ?? {}),
    role: hints?.role ?? derivedRole,
  };

  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const html = fetched.html;

  // List items first (the site uses bullet lists with one firm per item).
  const liRe = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m: RegExpExecArray | null;
  while ((m = liRe.exec(html)) !== null) {
    const block = m[1];
    const anchors = extractAnchors(block, url);
    const ext = anchors.find((a) =>
      /^https?:\/\//i.test(a.href)
      && !/foundersnextmove\./i.test(a.href)
      && !/(linkedin|twitter|x\.com|youtube|facebook)/i.test(a.href),
    );
    if (!ext) continue;
    const linkedin = anchors.find((a) => /linkedin\.com/i.test(a.href))?.href;
    const text = decodeEntities(ext.text || block.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const name = (text.split(/[–—\-•·\|]/)[0] || "").trim();
    if (!name || name.length < 2 || name.length > 80) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const description = decodeEntities(block.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 400);
    const cand = rowToCandidate({
      name,
      website: ext.href,
      thesis: description || null,
      LinkedIn: linkedin,
    }, url);
    if (!cand) continue;
    (cand.candidate as { import_key?: string }).import_key = importKey("fnm", name);
    firms.push(cand.candidate);
  }

  for (const f of firms) applyHints(f, mergedHints);
  return { firms, totalSeen: seen.size, errors: errors.length ? errors : undefined };
}

function deriveRoleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    const segs = u.pathname.toLowerCase().split("/").filter(Boolean);
    for (const seg of segs.reverse()) {
      if (ROLE_BY_SLUG[seg]) return ROLE_BY_SLUG[seg];
    }
  } catch { /* fall through */ }
  return null;
}
