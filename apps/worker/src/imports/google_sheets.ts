// Multi-tab Google Sheets fetcher. Given a "/edit#gid=…" URL we discover
// every tab in the workbook by scraping the editor HTML for the gid → name
// map, then download each tab's CSV via /export?format=csv&gid=N.
//
// Falls back to single-tab CSV if HTML scrape fails or sheet is private.

import type { ParsedTable } from "./csv";
import { parseCsv } from "./csv";

const SHEET_URL_RE = /docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/;

interface GsTab { gid: string; name: string }

/** Parse a Google Sheets URL into a docId. */
export function parseSheetId(url: string): string | null {
  const m = SHEET_URL_RE.exec(url);
  return m ? m[1] : null;
}

/** Discover all tabs in a sheet by scraping the public editor HTML. The
 *  sheet must be at least "Anyone with the link can view". */
export async function discoverTabs(docId: string): Promise<GsTab[]> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 10000);
  let html = "";
  try {
    const res = await fetch(
      `https://docs.google.com/spreadsheets/d/${docId}/edit`,
      { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 AIDataSignalBot/1.0" } },
    );
    if (!res.ok) return [];
    html = await res.text();
  } catch { return []; }
  finally { clearTimeout(timer); }
  return extractTabs(html);
}

/** Extract {gid, name} pairs from editor HTML. Sheet metadata appears in two
 *  places: the bootstrap JSON (`bootstrapData = {...}`) and the tab DOM
 *  elements (`<a id="sheet-button-..." ...>Name</a>`). We try the JSON first
 *  (canonical) and fall back to anchors. */
export function extractTabs(html: string): GsTab[] {
  const out: GsTab[] = [];
  const seen = new Set<string>();
  const push = (gid: string, name: string): void => {
    if (!gid || seen.has(gid)) return;
    seen.add(gid);
    out.push({ gid, name: (name || `Sheet ${gid}`).trim() });
  };
  // Pattern 1 — bootstrap JSON (canonical, both new and legacy field
  // names). Google ships both:
  //   {"name":"Sheet1","gid":"0",...}            (older bootstrapData)
  //   {"title":"Sheet1","sheetId":0,...}         (newer .sheets[*] shape)
  // Either order may appear, so we run both regexes and dedupe by gid.
  const jsonNameRe = /"name"\s*:\s*"([^"\\]{1,80})"[^}]{0,200}?"(?:gid|sheetId)"\s*:\s*(?:"(\d+)"|(\d+))/g;
  let m: RegExpExecArray | null;
  while ((m = jsonNameRe.exec(html)) !== null) push(m[2] || m[3], m[1]);
  const jsonTitleRe = /"title"\s*:\s*"([^"\\]{1,80})"[^}]{0,200}?"(?:sheetId|gid)"\s*:\s*(?:"(\d+)"|(\d+))/g;
  while ((m = jsonTitleRe.exec(html)) !== null) push(m[2] || m[3], m[1]);
  // Inverse order: sheetId before title.
  const jsonInvRe = /"sheetId"\s*:\s*(?:"(\d+)"|(\d+))[^}]{0,200}?"title"\s*:\s*"([^"\\]{1,80})"/g;
  while ((m = jsonInvRe.exec(html)) !== null) push(m[1] || m[2], m[3]);
  // Pattern 2 — bottom tab DOM. Two equivalent attributes are emitted by
  // the editor depending on rollout; match both.
  const anchorRe = /id="sheet-button-(\d+)"[^>]*>([^<]{1,80})</g;
  while ((m = anchorRe.exec(html)) !== null) push(m[1], m[2]);
  const dataIdRe = /data-id="(\d+)"[^>]{0,160}>([^<]{1,80})</g;
  while ((m = dataIdRe.exec(html)) !== null) push(m[1], m[2]);
  return out;
}

/** Fetch a single tab via the export endpoint in a given format. */
async function fetchTabAs(docId: string, gid: string, format: "csv" | "tsv"): Promise<string | null> {
  const url = `https://docs.google.com/spreadsheets/d/${docId}/export?format=${format}&gid=${gid}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 AIDataSignalBot/1.0" } });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

/** Download each tab and parse. Tries CSV first, then falls back to TSV
 *  when the CSV parse looks degenerate (≤1 column or single mega-row),
 *  which is the typical signature of comma-heavy data. */
export async function fetchAllTabs(docId: string, tabs: GsTab[]): Promise<ParsedTable[]> {
  const out: ParsedTable[] = [];
  for (const t of tabs) {
    const csv = await fetchTabAs(docId, t.gid, "csv");
    if (csv == null) continue;
    let tbl = parseCsv(csv);
    // Quality check: CSV parses with ≤1 column or one giant row almost always
    // indicates embedded commas defeating delimiter sniffing. Re-fetch as
    // TSV — Google Sheets exports tabs as field separators reliably.
    const looksDegenerate = tbl.headers.length <= 1 || (tbl.rows.length <= 1 && csv.length > 200);
    if (looksDegenerate) {
      const tsv = await fetchTabAs(docId, t.gid, "tsv");
      if (tsv) {
        const tsvTbl = parseCsv(tsv, "\t");
        if (tsvTbl.headers.length > tbl.headers.length) tbl = tsvTbl;
      }
    }
    if (tbl.headers.length) out.push({ ...tbl, sheetName: t.name });
  }
  return out;
}

/** End-to-end: URL → all tabs as ParsedTable[]. Returns [] if not a Google
 *  Sheets URL or discovery fails. */
export async function fetchGoogleSheet(url: string): Promise<ParsedTable[]> {
  const id = parseSheetId(url);
  if (!id) return [];
  const tabs = await discoverTabs(id);
  if (!tabs.length) {
    // Last-ditch: pull just the first/default tab.
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(
        `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`,
        { signal: ctl.signal, headers: { "User-Agent": "Mozilla/5.0 AIDataSignalBot/1.0" } },
      );
      if (!res.ok) return [];
      const csv = await res.text();
      const tbl = parseCsv(csv);
      return tbl.headers.length ? [{ ...tbl, sheetName: "Sheet1" }] : [];
    } catch { return []; }
    finally { clearTimeout(timer); }
  }
  return fetchAllTabs(id, tabs);
}
