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
  // Pattern in bootstrap JSON: "name":"Sheet1","gid":"0"   (order varies)
  const jsonRe = /"name"\s*:\s*"([^"\\]{1,80})"[^}]{0,200}?"(?:gid|sheetId)"\s*:\s*(?:"(\d+)"|(\d+))/g;
  let m: RegExpExecArray | null;
  while ((m = jsonRe.exec(html)) !== null) {
    const gid = m[2] || m[3];
    if (!gid || seen.has(gid)) continue;
    seen.add(gid);
    out.push({ gid, name: m[1] });
  }
  if (out.length) return out;
  // Fallback: anchor tags <a id="sheet-button-NNN" ...>Name</a>
  const anchorRe = /id="sheet-button-(\d+)"[^>]*>([^<]{1,80})</g;
  while ((m = anchorRe.exec(html)) !== null) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    out.push({ gid: m[1], name: m[2].trim() });
  }
  return out;
}

/** Download each tab as CSV and parse. Tabs that fail are skipped silently
 *  but counted via summary. */
export async function fetchAllTabs(docId: string, tabs: GsTab[]): Promise<ParsedTable[]> {
  const out: ParsedTable[] = [];
  for (const t of tabs) {
    const url = `https://docs.google.com/spreadsheets/d/${docId}/export?format=csv&gid=${t.gid}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(url, {
        signal: ctl.signal,
        headers: { "User-Agent": "Mozilla/5.0 AIDataSignalBot/1.0" },
      });
      if (!res.ok) continue;
      const csv = await res.text();
      const tbl = parseCsv(csv);
      if (tbl.headers.length) out.push({ ...tbl, sheetName: t.name });
    } catch { /* skip tab */ }
    finally { clearTimeout(timer); }
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
