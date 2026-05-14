import type { Env } from "../../../types";
import { fetchPage } from "../../fetcher";
import { decodeEntities } from "../../html";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { rowToCandidate } from "./_helpers";

/**
 * Airtable share-view importer.
 *
 * Strategy (in order):
 * 1) Browser-rendered fetch of the share URL, then look for the inline
 *    `window.__INITIAL_DATA__ = {...}` blob Airtable embeds.
 * 2) Fallback: `readSharedViewData` XHR — Airtable share pages call
 *    `https://airtable.com/v0.3/view/<viewId>/readSharedViewData?...`.
 *    We extract the `viewId` (first `shrXXXX` / `viwXXXX` segment in the URL)
 *    and POST against the same endpoint with the share's `applicationId`.
 *    If that fails we fall through to (3).
 * 3) Last resort: parse any visible `<table>` cells from the rendered DOM.
 */
export async function importFirms(url: string, env: Env): Promise<FirmlistImportResult> {
  const errors: string[] = [];
  const fetched = await fetchPage(env, url, { forceBrowser: true });
  if (!fetched.ok) {
    return { firms: [], totalSeen: 0, errors: [`fetch_failed:${fetched.blockReason ?? "unknown"}`] };
  }
  const html = fetched.html;

  // (1) Inline __INITIAL_DATA__ blob.
  const initial = extractInitialData(html);
  if (initial) {
    const rows = extractAirtableRows(initial);
    if (rows.length) return rowsToResult(rows, url);
  }

  // (2) readSharedViewData fallback.
  try {
    const json = await readSharedViewData(url);
    if (json) {
      const rows = extractAirtableRows(json);
      if (rows.length) return rowsToResult(rows, url);
    }
  } catch (e) {
    errors.push(`readSharedViewData:${(e as Error).message}`);
  }

  // (3) Plain DOM table fallback.
  const tableRows = scrapeRenderedTable(html);
  if (tableRows.length) return rowsToResult(tableRows, url);

  return { firms: [], totalSeen: 0, errors };
}

function extractInitialData(html: string): unknown | null {
  // Airtable's share page assigns `window.__INITIAL_DATA__ = {...};`
  const m = html.match(/window\.__INITIAL_DATA__\s*=\s*(\{[\s\S]*?\});/);
  if (!m) return null;
  try {
    return JSON.parse(decodeEntities(m[1]));
  } catch {
    return null;
  }
}

/**
 * Walk the heavily-nested Airtable JSON to surface row records as
 * `{ headerName: value }` plain objects. The share-view payload contains
 * `columns` (id → name) and `rows` (with a `cellValuesByColumnId`).
 */
function extractAirtableRows(blob: unknown): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const found = findShape(blob);
  if (!found) return out;
  const colIdToName = new Map<string, string>();
  for (const c of found.columns) {
    if (c && typeof c === "object") {
      const id = (c as { id?: string }).id;
      const name = (c as { name?: string }).name;
      if (id && name) colIdToName.set(id, name);
    }
  }
  for (const r of found.rows) {
    const cellValues = (r as { cellValuesByColumnId?: Record<string, unknown> }).cellValuesByColumnId;
    if (!cellValues) continue;
    const row: Record<string, unknown> = {};
    for (const [cid, val] of Object.entries(cellValues)) {
      const name = colIdToName.get(cid) ?? cid;
      row[name] = stringifyAirtableCell(val);
    }
    out.push(row);
  }
  return out;
}

function findShape(blob: unknown): { columns: unknown[]; rows: unknown[] } | null {
  if (!blob || typeof blob !== "object") return null;
  const stack: unknown[] = [blob];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    const o = cur as Record<string, unknown>;
    if (Array.isArray(o.columns) && Array.isArray(o.rows)) {
      return { columns: o.columns, rows: o.rows };
    }
    for (const v of Object.values(o)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return null;
}

function stringifyAirtableCell(val: unknown): string {
  if (val == null) return "";
  if (typeof val === "string" || typeof val === "number") return String(val);
  if (Array.isArray(val)) {
    return val.map((v) => stringifyAirtableCell(v)).filter(Boolean).join(", ");
  }
  if (typeof val === "object") {
    const o = val as Record<string, unknown>;
    if (typeof o.name === "string") return o.name;
    if (typeof o.url === "string") return o.url;
    if (typeof o.label === "string") return o.label;
    return JSON.stringify(o);
  }
  return String(val);
}

async function readSharedViewData(shareUrl: string): Promise<unknown | null> {
  // The share URL takes the form https://airtable.com/<appId>/<shr...>/<viw...>?...
  const m = shareUrl.match(/airtable\.com\/(app[A-Za-z0-9]+)\/(shr[A-Za-z0-9]+)/);
  if (!m) return null;
  const appId = m[1];
  const shareId = m[2];
  const endpoint = `https://airtable.com/v0.3/view/${shareId}/readSharedViewData?stringifiedObjectParams=%7B%7D&requestId=${Math.random().toString(36).slice(2)}&accessPolicy=%7B%7D`;
  const res = await fetch(endpoint, {
    headers: {
      "x-airtable-application-id": appId,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 AIDataSignal/1.0",
    },
  });
  if (!res.ok) return null;
  return res.json();
}

const TR_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
const TAG_RE = /<[^>]+>/g;

function scrapeRenderedTable(html: string): Array<Record<string, unknown>> {
  TR_RE.lastIndex = 0;
  const rows: string[][] = [];
  let m: RegExpExecArray | null;
  while ((m = TR_RE.exec(html)) !== null) {
    const cells: string[] = [];
    CELL_RE.lastIndex = 0;
    let cm: RegExpExecArray | null;
    while ((cm = CELL_RE.exec(m[1])) !== null) {
      cells.push(decodeEntities(cm[1].replace(TAG_RE, " ").replace(/\s+/g, " ").trim()));
    }
    if (cells.length) rows.push(cells);
  }
  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map((r) => {
    const o: Record<string, unknown> = {};
    for (let i = 0; i < headers.length && i < r.length; i++) o[headers[i]] = r[i];
    return o;
  });
}

function rowsToResult(rows: Array<Record<string, unknown>>, sourceUrl: string): FirmlistImportResult {
  const firms: FirmCandidate[] = [];
  for (const r of rows) {
    const c = rowToCandidate(r, sourceUrl);
    if (c) firms.push(c.candidate);
  }
  return { firms, totalSeen: rows.length };
}
