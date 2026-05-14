import type { Env } from "../../../types";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { rowToCandidate } from "./_helpers";

/**
 * Google Sheets importer.
 *
 * Hits the public `gviz/tq` endpoint that any anybody-with-the-link sheet
 * exposes. The endpoint returns JSONP wrapped JSON of the form:
 *   /*O_o*\/google.visualization.Query.setResponse({...});
 * We strip the wrapper and parse the embedded `table` payload.
 */
export async function importFirms(url: string, _env: Env): Promise<FirmlistImportResult> {
  const ids = parseSheetUrl(url);
  if (!ids) return { firms: [], totalSeen: 0, errors: ["unrecognized_sheet_url"] };
  const { sheetId, gid } = ids;
  const tqUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json${gid != null ? `&gid=${gid}` : ""}`;
  const res = await fetch(tqUrl, { headers: { Accept: "application/json" } });
  if (!res.ok) return { firms: [], totalSeen: 0, errors: [`status_${res.status}`] };
  const text = await res.text();
  const m = text.match(/google\.visualization\.Query\.setResponse\((\{[\s\S]*\})\)/);
  if (!m) return { firms: [], totalSeen: 0, errors: ["jsonp_unparseable"] };
  let payload: unknown;
  try {
    payload = JSON.parse(m[1]);
  } catch (e) {
    return { firms: [], totalSeen: 0, errors: [`json_parse:${(e as Error).message}`] };
  }
  const table = (payload as { table?: GVizTable }).table;
  if (!table || !Array.isArray(table.cols) || !Array.isArray(table.rows)) {
    return { firms: [], totalSeen: 0, errors: ["empty_table"] };
  }
  // Use the first non-empty row that looks like headers if `cols[*].label` is
  // empty (gviz quirk: when the sheet's first row IS the header, it ends up
  // as the first data row and `cols` get auto-generated labels A, B, C, ...).
  let headers = table.cols.map((c) => (c.label || "").trim());
  let dataRows = table.rows;
  if (headers.every((h) => !h) && dataRows.length) {
    headers = (dataRows[0].c ?? []).map((c) => (c?.v != null ? String(c.v).trim() : ""));
    dataRows = dataRows.slice(1);
  }

  const firms: FirmCandidate[] = [];
  let seen = 0;
  for (const r of dataRows) {
    seen += 1;
    const o: Record<string, unknown> = {};
    const cells = r.c ?? [];
    for (let i = 0; i < headers.length; i++) {
      const cell = cells[i];
      const v = cell?.f ?? cell?.v;
      if (v != null && v !== "") o[headers[i] || `col_${i}`] = v;
    }
    const c = rowToCandidate(o, url);
    if (c) firms.push(c.candidate);
  }
  return { firms, totalSeen: seen };
}

interface GVizTable {
  cols: Array<{ id?: string; label?: string; type?: string }>;
  rows: Array<{ c: Array<{ v?: unknown; f?: unknown } | null> }>;
}

function parseSheetUrl(url: string): { sheetId: string; gid: string | null } | null {
  // /spreadsheets/d/<id>/edit#gid=...   or   /spreadsheets/d/<id>/...?gid=...
  const m = url.match(/spreadsheets\/d\/([A-Za-z0-9_-]+)/);
  if (!m) return null;
  let gid: string | null = null;
  const hash = url.split("#")[1] ?? "";
  const query = url.split("?")[1] ?? "";
  const gidMatch = (hash + "&" + query).match(/gid=(\d+)/);
  if (gidMatch) gid = gidMatch[1];
  return { sheetId: m[1], gid };
}
