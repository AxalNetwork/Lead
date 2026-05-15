// XLSX/XLS/ODS parser via SheetJS. Loaded dynamically so tsc doesn't choke
// when the optional dep is absent in some environments.

import type { ParsedTable } from "./csv";

interface XlsxLike {
  read: (data: Uint8Array, opts: Record<string, unknown>) => XlsxWorkbook;
  utils: {
    sheet_to_json: (sheet: unknown, opts: Record<string, unknown>) => unknown[][];
  };
}
interface XlsxWorkbook { SheetNames: string[]; Sheets: Record<string, unknown> }

let cached: XlsxLike | null | undefined;
async function loadXlsx(): Promise<XlsxLike | null> {
  if (cached !== undefined) return cached;
  try {
    const specifier = "xlsx";
    const mod = (await import(/* @vite-ignore */ specifier).catch(() => null)) as
      | XlsxLike | { default: XlsxLike } | null;
    cached = mod ? (("default" in mod ? mod.default : mod) as XlsxLike) : null;
  } catch { cached = null; }
  return cached;
}

/**
 * Parse a workbook (XLSX, XLS, ODS, or even CSV — SheetJS sniffs format from
 * the bytes). Returns the first sheet that has at least one data row. We use
 * header:1 to get raw rows then build {headers, rows} ourselves so empty
 * cells stay aligned with their headers.
 */
export async function parseSpreadsheet(bytes: ArrayBuffer): Promise<ParsedTable> {
  const xlsx = await loadXlsx();
  if (!xlsx) throw new Error("xlsx_unavailable");
  const wb = xlsx.read(new Uint8Array(bytes), { type: "array", cellDates: true });
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as unknown[][];
    if (!matrix.length) continue;
    const rawHeaders = (matrix[0] ?? []).map((h) => String(h ?? "").trim());
    if (!rawHeaders.some(Boolean)) continue;
    const headers = rawHeaders;
    const rows: Array<Record<string, string>> = [];
    for (let r = 1; r < matrix.length; r++) {
      const arr = matrix[r] ?? [];
      const obj: Record<string, string> = {};
      let any = false;
      for (let c = 0; c < headers.length; c++) {
        const v = arr[c];
        const s = v == null ? "" : (v instanceof Date ? v.toISOString() : String(v)).trim();
        obj[headers[c]] = s;
        if (s) any = true;
      }
      if (any) rows.push(obj);
    }
    if (rows.length) return { headers, rows };
  }
  return { headers: [], rows: [] };
}
