// XLSX/XLS/ODS parser via SheetJS. Loaded dynamically so tsc doesn't choke
// when the optional dep is absent in some environments.
//
// v2 (Task #2): returns ALL non-empty sheets so the per-tab routing in
// parse.ts can classify each tab's intent independently.

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

/** Parse every non-empty sheet in a workbook. Returns one ParsedTable per
 *  sheet, in workbook order, with `sheetName` populated. The header row is
 *  detected as the first non-empty row in each sheet. */
export async function parseSpreadsheet(bytes: ArrayBuffer): Promise<ParsedTable[]> {
  const xlsx = await loadXlsx();
  if (!xlsx) throw new Error("xlsx_unavailable");
  const wb = xlsx.read(new Uint8Array(bytes), { type: "array", cellDates: true });
  const out: ParsedTable[] = [];
  for (const name of wb.SheetNames) {
    const sheet = wb.Sheets[name];
    const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: "" }) as unknown[][];
    if (!matrix.length) continue;
    // Find first row with >=2 non-empty cells; everything above is title/meta.
    let hi = 0;
    for (; hi < matrix.length; hi++) {
      const r = (matrix[hi] ?? []).map((v) => String(v ?? "").trim());
      if (r.filter(Boolean).length >= 2) break;
    }
    if (hi >= matrix.length) continue;
    const rawHeaders = (matrix[hi] ?? []).map((v) => String(v ?? "").trim());
    const headers = dedupeHeaders(rawHeaders);
    const rows: Array<Record<string, string>> = [];
    for (let r = hi + 1; r < matrix.length; r++) {
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
    if (rows.length || headers.some(Boolean)) out.push({ headers, rows, sheetName: name });
  }
  return out;
}

/** Make duplicate headers unique by suffixing _2, _3, .... Empty headers
 *  become col_<index> so projectRow can still address them. */
function dedupeHeaders(raw: string[]): string[] {
  const seen = new Map<string, number>();
  return raw.map((h, i) => {
    let base = h && h.trim() ? h.trim() : `col_${i + 1}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return n === 1 ? base : `${base}_${n}`;
  });
}
