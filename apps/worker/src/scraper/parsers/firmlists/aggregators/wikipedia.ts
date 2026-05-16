import type { Env } from "../../../../types";
import { decodeEntities } from "../../../html";
import type { FirmCandidate, FirmlistImportResult } from "../types";
import { rowToCandidate, parseUsdAmount } from "../_helpers";
import { applyHints, awaitHostSlot, importKey, type AggregatorHints } from "./_base";

/**
 * Wikipedia importer (en.wikipedia.org).
 *
 * Reads a list page (e.g. `/wiki/List_of_venture_capital_firms`) via
 * the REST API (`/api/rest_v1/page/html/{title}`) which returns stable,
 * cacheable HTML without the chrome / talk / edit links. We then:
 *   1. Parse every `<table class="wikitable">` row to surface firm
 *      names + wiki links.
 *   2. For each row whose anchor points to another wiki article, fetch
 *      that article and parse its Infobox (AUM, founded, HQ, key
 *      people) — bounded to a per-import cap so a single 500-firm list
 *      doesn't fan out to 500 fetches.
 *
 * Every emitted firm carries `source_url = wiki article URL` so the
 * pipeline persists the wiki page as the evidence_url, satisfying the
 * Task #3 done-criterion "every record is cited with source_kind=
 * 'wikipedia' + evidence_url".
 */

const REST_BASE = "https://en.wikipedia.org/api/rest_v1/page/html/";
const INFOBOX_FETCH_CAP_DEFAULT = 50; // override via env.AGG_WIKIPEDIA_INFOBOX_CAP

export async function importFirms(url: string, env: Env, hints?: AggregatorHints): Promise<FirmlistImportResult> {
  const title = wikiTitleFromUrl(url);
  if (!title) return { firms: [], totalSeen: 0, errors: ["bad_wikipedia_url"] };

  await awaitHostSlot(env, url);
  const listHtml = await fetchRestHtml(title);
  if (!listHtml) return { firms: [], totalSeen: 0, errors: ["rest_api_fetch_failed"] };

  const rows = extractWikitableRows(listHtml);
  const seen = new Set<string>();
  const firms: FirmCandidate[] = [];
  const errors: string[] = [];

  const cap = readInfoboxCap(env);
  let fetchedInfoboxes = 0;

  for (const r of rows) {
    if (!r.name) continue;
    const key = r.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const baseRow: Record<string, unknown> = { name: r.name };
    if (r.summary) baseRow.thesis = r.summary;

    let infobox: WikipediaInfobox | null = null;
    if (r.wikiSlug && fetchedInfoboxes < cap) {
      // Count attempts (not successes) so a run of 404s can't blow
      // through the cap and trigger hundreds of REST hits per import.
      fetchedInfoboxes += 1;
      await awaitHostSlot(env, REST_BASE + r.wikiSlug);
      const ih = await fetchRestHtml(r.wikiSlug);
      if (ih) {
        infobox = parseInfobox(ih);
      } else {
        errors.push(`infobox_fetch_failed:${r.wikiSlug}`);
      }
    }
    if (infobox) {
      if (infobox.website) baseRow.website = infobox.website;
      if (infobox.aum) baseRow.aum = infobox.aum;
      if (infobox.founded) baseRow.founded = infobox.founded;
      if (infobox.hq) baseRow.hq = infobox.hq;
    }

    const cand = rowToCandidate(baseRow, url);
    if (!cand) continue;
    // Per spec — every record cites the wiki article URL.
    cand.candidate.source_url = r.wikiSlug
      ? `https://en.wikipedia.org/wiki/${r.wikiSlug}`
      : url;
    if (infobox?.aumUsd != null) cand.candidate.aum_usd = infobox.aumUsd;
    (cand.candidate as { import_key?: string }).import_key = importKey("wikipedia", r.name);
    firms.push(cand.candidate);
  }

  for (const f of firms) applyHints(f, hints);
  return { firms, totalSeen: rows.length, errors: errors.length ? errors : undefined };
}

function wikiTitleFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/wikipedia\.org$/i.test(u.hostname)) return null;
    const m = u.pathname.match(/^\/wiki\/(.+)$/);
    if (!m) return null;
    return decodeURIComponent(m[1]).replace(/\s+/g, "_");
  } catch { return null; }
}

async function fetchRestHtml(title: string): Promise<string | null> {
  try {
    const r = await fetch(REST_BASE + encodeURIComponent(title), {
      headers: {
        accept: "text/html",
        "user-agent": "AIDataSignal/1.0 (https://aidatasignal.com; contact@aidatasignal.com)",
      },
    });
    if (!r.ok) return null;
    return await r.text();
  } catch { return null; }
}

function readInfoboxCap(env: Env): number {
  const raw = (env as unknown as Record<string, string | undefined>).AGG_WIKIPEDIA_INFOBOX_CAP;
  const n = raw ? Number(raw) : NaN;
  if (Number.isFinite(n) && n > 0) return Math.min(n, 500);
  return INFOBOX_FETCH_CAP_DEFAULT;
}

interface WikiRow {
  name: string;
  wikiSlug: string | null;
  summary: string | null;
}

function extractWikitableRows(html: string): WikiRow[] {
  const out: WikiRow[] = [];
  const tableRe = /<table\b[^>]*class=["'][^"']*wikitable[^"']*["'][^>]*>([\s\S]*?)<\/table>/gi;
  let tm: RegExpExecArray | null;
  while ((tm = tableRe.exec(html)) !== null) {
    const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(tm[1])) !== null) {
      const row = rm[1];
      if (!/\<t[dh]/i.test(row)) continue;
      // First cell normally carries the firm anchor.
      const firstCell = row.match(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/i);
      if (!firstCell) continue;
      const cell = firstCell[1];
      const anchor = cell.match(/<a\b[^>]*href=["']\/wiki\/([^"'#?]+)["'][^>]*>([\s\S]*?)<\/a>/i);
      if (anchor) {
        const slug = decodeURIComponent(anchor[1]).replace(/\s+/g, "_");
        if (slug.startsWith("File:") || slug.startsWith("Help:") || slug.startsWith("Special:")) continue;
        const name = decodeEntities(anchor[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
        if (!name) continue;
        const summary = decodeEntities(row.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 400);
        out.push({ name, wikiSlug: slug, summary: summary || null });
      } else {
        const name = decodeEntities(cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
        if (!name || name.length < 2 || name.length > 120) continue;
        out.push({ name, wikiSlug: null, summary: null });
      }
    }
  }
  return out;
}

interface WikipediaInfobox {
  website: string | null;
  aum: string | null;
  aumUsd: number | null;
  founded: string | null;
  hq: string | null;
  keyPeople: string | null;
}

function parseInfobox(html: string): WikipediaInfobox {
  const out: WikipediaInfobox = { website: null, aum: null, aumUsd: null, founded: null, hq: null, keyPeople: null };
  const box = html.match(/<table\b[^>]*class=["'][^"']*infobox[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!box) return out;
  const rowRe = /<tr\b[^>]*>\s*<th\b[^>]*>([\s\S]*?)<\/th>\s*<td\b[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(box[1])) !== null) {
    const label = decodeEntities(m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).toLowerCase();
    const cell = m[2];
    const value = decodeEntities(cell.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
    if (!value) continue;
    if (/^website|url$/i.test(label)) {
      const link = cell.match(/<a\b[^>]*href=["'](https?:\/\/[^"']+)["']/i);
      out.website = link ? link[1] : value;
    } else if (/assets under management|aum|total assets/.test(label)) {
      out.aum = value;
      const n = parseUsdAmount(value);
      if (n) out.aumUsd = n;
    } else if (/^founded|established|formed/.test(label)) {
      out.founded = value;
    } else if (/headquarter|^hq|location|based in/i.test(label)) {
      out.hq = value;
    } else if (/key people|founders?|chief executive|ceo|managing/i.test(label)) {
      if (!out.keyPeople) out.keyPeople = value;
    }
  }
  return out;
}
