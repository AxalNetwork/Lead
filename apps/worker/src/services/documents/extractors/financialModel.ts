// Task #13: Financial-model extractor.
//
// Operates on XLSX-derived structured data. Looks for revenue, expense,
// headcount, ARR ramp, and burn rows across the workbook. Caller is
// responsible for parsing the XLSX file with the existing xlsx
// dependency; this module consumes a normalized `Sheet[]` shape so
// the extractor is unit-testable without a real workbook.

export const FINANCIAL_MODEL_EXTRACTOR_VERSION = "1.0.0";

export interface SheetRow { [columnHeader: string]: string | number | null; }
export interface Sheet { name: string; rows: SheetRow[]; headers: string[]; }

export interface FinancialModelExtraction {
  sheet_names: string[];
  detected_periods: string[];          // e.g. ["2024 Q1", "2024 Q2", …]
  arr_ramp_usd: Array<{ period: string; arr_usd: number }>;
  revenue_by_period_usd: Array<{ period: string; revenue_usd: number }>;
  burn_by_period_usd: Array<{ period: string; burn_usd: number }>;
  headcount_by_period: Array<{ period: string; headcount: number }>;
  warnings: string[];
}

function isPeriodHeader(h: string): boolean {
  return /^(20\d{2})(?:[-\s/]?(q[1-4]|h[12]|\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)?)?$/i.test(h.trim());
}

function toNumber(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const t = String(v).replace(/[$,\s()]/g, "");
  const negative = String(v).includes("(") && String(v).includes(")");
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function findRow(sheet: Sheet, needleRegex: RegExp): SheetRow | null {
  const labelHeader = sheet.headers[0];
  if (!labelHeader) return null;
  for (const r of sheet.rows) {
    const label = String(r[labelHeader] ?? "").toLowerCase();
    if (needleRegex.test(label)) return r;
  }
  return null;
}

function periodColumns(sheet: Sheet): string[] {
  return sheet.headers.filter(isPeriodHeader);
}

function rowSeries(_sheet: Sheet, row: SheetRow, periods: string[]): Array<{ period: string; value: number }> {
  const out: Array<{ period: string; value: number }> = [];
  for (const p of periods) {
    const n = toNumber(row[p]);
    if (n != null) out.push({ period: p, value: n });
  }
  return out;
}

export function extractFinancialModel(sheets: Sheet[]): FinancialModelExtraction {
  const warnings: string[] = [];
  const sheet_names = sheets.map((s) => s.name);
  const allPeriods = new Set<string>();
  const arr_ramp_usd: FinancialModelExtraction["arr_ramp_usd"] = [];
  const revenue_by_period_usd: FinancialModelExtraction["revenue_by_period_usd"] = [];
  const burn_by_period_usd: FinancialModelExtraction["burn_by_period_usd"] = [];
  const headcount_by_period: FinancialModelExtraction["headcount_by_period"] = [];

  for (const sheet of sheets) {
    const periods = periodColumns(sheet);
    for (const p of periods) allPeriods.add(p);
    const arrRow = findRow(sheet, /^arr\b|annual\s+recurring\s+revenue/);
    const revRow = findRow(sheet, /^(total\s+)?revenue\b|net\s+revenue|gross\s+revenue/);
    const burnRow = findRow(sheet, /^(net\s+)?burn\b|cash\s+burn/);
    const hcRow = findRow(sheet, /^(total\s+)?headcount\b|ftes?\b/);
    if (arrRow) for (const x of rowSeries(sheet, arrRow, periods)) arr_ramp_usd.push({ period: x.period, arr_usd: Math.round(x.value) });
    if (revRow) for (const x of rowSeries(sheet, revRow, periods)) revenue_by_period_usd.push({ period: x.period, revenue_usd: Math.round(x.value) });
    if (burnRow) for (const x of rowSeries(sheet, burnRow, periods)) burn_by_period_usd.push({ period: x.period, burn_usd: Math.round(Math.abs(x.value)) });
    if (hcRow) for (const x of rowSeries(sheet, hcRow, periods)) headcount_by_period.push({ period: x.period, headcount: Math.round(x.value) });
  }
  if (arr_ramp_usd.length === 0 && revenue_by_period_usd.length === 0) warnings.push("no_revenue_or_arr_series_found");
  return {
    sheet_names,
    detected_periods: Array.from(allPeriods),
    arr_ramp_usd, revenue_by_period_usd, burn_by_period_usd, headcount_by_period,
    warnings,
  };
}
