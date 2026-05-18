// Task #2: Shared parsing primitives for LP-disclosure adapters.
//
// LP quarterly PE program reports are tabular: one row per fund with
// columns (fund_name, vintage, commitment, contributions, distributions,
// nav, irr). The exact column order, headers, and units vary per LP,
// but the row shape is universal.
//
// The shared parser:
//   1. Normalizes the input (PDF text or HTML) to a sequence of "rows"
//      — line-broken sequences of whitespace-separated tokens.
//   2. Sniffs a header row to discover which columns hold which fields.
//   3. Detects the table's unit hint (e.g. "$ in thousands", "millions")
//      from text surrounding the header.
//   4. Walks the body rows, extracting one LpCommitmentCandidate each.
//
// Tolerant by design: a row with no fund name (e.g. a subtotal line) is
// dropped silently; a row missing IRR keeps the rest of the numerics.

import type { LpCommitmentCandidate } from "./types";
import { stripTags } from "../_util";

/** Coerce input that may be HTML to a flat text view useful for table
 *  walking. PDFs are passed in as text already (the fetch tier runs
 *  pdfjs upstream); HTML pages get stripped to text. */
export function toText(input: string): string {
  if (!input) return "";
  return input.includes("<") && input.includes(">") ? stripTags(input) : input;
}

/** Find a date stamp anywhere in a header/footer string. Recognizes
 *  "as of June 30, 2024", "Q2 2024", "12/31/2023", "2024-03-31". */
export function findAsOfDate(text: string): string | null {
  const t = text.replace(/\s+/g, " ");
  // ISO
  let m = /\b(20\d{2})-(\d{2})-(\d{2})\b/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // US numeric
  m = /\b(\d{1,2})\/(\d{1,2})\/(20\d{2})\b/.exec(t);
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  // Month name
  const months = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  m = /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(20\d{2})\b/i.exec(t);
  if (m) {
    const mm = String(months.indexOf(m[1].toLowerCase()) + 1).padStart(2, "0");
    const dd = m[2].padStart(2, "0");
    return `${m[3]}-${mm}-${dd}`;
  }
  // Quarter — map to quarter-end
  m = /\bQ([1-4])\s+(20\d{2})\b/.exec(t);
  if (m) {
    const q = Number(m[1]);
    const qend = ["03-31","06-30","09-30","12-31"][q - 1];
    return `${m[2]}-${qend}`;
  }
  return null;
}

const MULTIPLIER_RE = /(?:\$|amounts?|figures?|dollars?)?\s*(?:in|of)?\s*(thousands|millions|billions)\b/i;

export function detectUnitMultiplier(text: string): number {
  const m = MULTIPLIER_RE.exec(text);
  if (!m) return 1;
  const w = m[1].toLowerCase();
  if (w === "thousands") return 1_000;
  if (w === "millions") return 1_000_000;
  if (w === "billions") return 1_000_000_000;
  return 1;
}

/** Parse a money-ish string. Accepts "$1,234,567", "(1,234)" (negative),
 *  "1.2", "N/A", "—". Returns null when not numeric. The multiplier
 *  (from detectUnitMultiplier) is applied by the caller. */
export function parseMoney(s: string | null | undefined): number | null {
  if (s == null) return null;
  const raw = String(s).trim();
  if (!raw || /^(n\/a|na|—|-|–)$/i.test(raw)) return null;
  const neg = /^\(.+\)$/.test(raw);
  const cleaned = raw.replace(/[(),$\s]/g, "").replace(/^\$/, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

/** Parse a percent-ish string. Accepts "18.4%", "18.4", "(2.1)%", "N/A".
 *  Returns 0..100 (so 18.4% → 18.4). */
export function parsePercent(s: string | null | undefined): number | null {
  if (s == null) return null;
  const raw = String(s).trim();
  if (!raw || /^(n\/a|na|—|-|–|nm)$/i.test(raw)) return null;
  const neg = /^\(.+\)%?$/.test(raw);
  const cleaned = raw.replace(/[%()$\s,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

export function parseVintage(s: string | null | undefined): number | null {
  if (s == null) return null;
  const m = /\b(19[89]\d|20\d{2})\b/.exec(String(s));
  if (!m) return null;
  const y = Number(m[1]);
  return y >= 1980 && y <= 2099 ? y : null;
}

export interface ColumnMap {
  fund_name: number;
  vintage_year?: number;
  committed?: number;
  called?: number;
  distributed?: number;
  nav?: number;
  net_irr?: number;
  tvpi?: number;
  dpi?: number;
  gp_firm?: number;
}

const HEADER_SYNONYMS: Record<keyof ColumnMap, RegExp[]> = {
  fund_name:    [/\b(fund|partnership|investment|name|manager\s+\/\s+fund)\b/i],
  vintage_year: [/\bvintage\b/i, /\bvintage\s+year\b/i],
  committed:    [/\bcommit(ted|ment)?\b/i, /\bcapital\s+commit/i],
  called:       [/\b(paid[\s-]?in|contribution|called|capital\s+called|drawn)\b/i],
  distributed:  [/\b(distribut|cash\s+distributions?)\b/i],
  nav:          [/\b(nav|net\s+asset\s+value|market\s+value|remaining\s+value|reported\s+value)\b/i],
  net_irr:      [/\b(net\s+irr|irr|since[\s-]inception\s+irr)\b/i],
  tvpi:         [/\btvpi\b/i, /\btotal\s+value\s+(to|\/)\s+paid[\s-]?in\b/i],
  dpi:          [/\bdpi\b/i, /\bdistributions?\s+(to|\/)\s+paid[\s-]?in\b/i],
  gp_firm:      [/\b(manager|sponsor|gp|general\s+partner|firm)\b/i],
};

/** Identify column positions by scanning a header row. Returns null
 *  when no fund-name column is found (i.e. this isn't a fund table). */
export function detectColumns(headerCells: string[]): ColumnMap | null {
  const map: Partial<ColumnMap> = {};
  for (let i = 0; i < headerCells.length; i++) {
    const cell = headerCells[i] ?? "";
    for (const key of Object.keys(HEADER_SYNONYMS) as Array<keyof ColumnMap>) {
      if (map[key] != null) continue;
      if (HEADER_SYNONYMS[key].some((re) => re.test(cell))) {
        map[key] = i;
        break;
      }
    }
  }
  if (map.fund_name == null) return null;
  return map as ColumnMap;
}

/** Split a single text line into table cells. Handles:
 *   - HTML <td>/<th> emitted as " | " sentinels by stripTags-then-split
 *   - PDF text where columns are separated by 2+ spaces or tab
 *   - CSV-like single-space rows with a trailing numeric block
 *
 * We use the "two-or-more whitespace" rule as the primary splitter.
 * That matches both PDF text extraction (column gaps emit ≥2 spaces)
 * and tab-delimited rows. */
export function splitRow(line: string): string[] {
  const t = line.replace(/\t/g, "    ").trimEnd();
  if (!t.trim()) return [];
  return t.split(/\s{2,}/).map((c) => c.trim()).filter((c) => c.length > 0);
}

function isHeaderRow(cells: string[]): boolean {
  const joined = cells.join(" | ").toLowerCase();
  return /\bvintage\b/.test(joined)
      && (/\bcommit/.test(joined) || /\bpaid[\s-]?in\b/.test(joined) || /\bnav\b/.test(joined) || /\birr\b/.test(joined));
}

/** Drop rows that are subtotals, footnotes, or section headers — they
 *  share the table shape but aren't fund rows. */
function isFundNameLike(cell: string): boolean {
  const s = cell.trim();
  if (!s) return false;
  if (s.length < 3 || s.length > 200) return false;
  if (/^(total|subtotal|grand\s+total|sum|portfolio|note|footnote)\b/i.test(s)) return false;
  if (/^page\s+\d+/i.test(s)) return false;
  if (/^\d[\d.,%\s]*$/.test(s)) return false; // pure numeric row
  return /[a-z]/i.test(s);
}

export interface ParseLpTableOptions {
  /** Override the unit multiplier when the disclosure declares it
   *  out-of-band (e.g. CalPERS prints "$ in thousands" once on the
   *  cover and then never repeats it). */
  unit_multiplier?: number;
  /** Force a column map when the header is non-standard. */
  columns?: ColumnMap;
}

/** Generic LP table walker. Takes preformatted text and emits one
 *  candidate per fund row. Used directly by the per-LP adapters; each
 *  per-LP file customizes only the input pre-processing + the LP slug
 *  + URL pattern. */
export function parseLpTable(
  text: string,
  opts: ParseLpTableOptions = {},
): LpCommitmentCandidate[] {
  const lines = text.split(/\r?\n/);
  const multiplier = opts.unit_multiplier ?? detectUnitMultiplier(text);
  let columns: ColumnMap | null = opts.columns ?? null;
  const out: LpCommitmentCandidate[] = [];
  for (const rawLine of lines) {
    const cells = splitRow(rawLine);
    if (cells.length < 3) continue;
    if (!columns) {
      if (isHeaderRow(cells)) columns = detectColumns(cells);
      continue;
    }
    const name = cells[columns.fund_name];
    if (!isFundNameLike(name ?? "")) continue;
    const pick = (i: number | undefined): string | null =>
      i == null || i >= cells.length ? null : (cells[i] ?? null);
    const moneyApply = (n: number | null): number | null => n == null ? null : Math.round(n * multiplier);

    out.push({
      fund_name_raw: name.trim(),
      vintage_year: parseVintage(pick(columns.vintage_year)),
      committed_usd: moneyApply(parseMoney(pick(columns.committed))),
      called_usd:    moneyApply(parseMoney(pick(columns.called))),
      distributed_usd: moneyApply(parseMoney(pick(columns.distributed))),
      nav_usd:       moneyApply(parseMoney(pick(columns.nav))),
      net_irr_pct:   parsePercent(pick(columns.net_irr)),
      tvpi:          parsePercent(pick(columns.tvpi)),
      dpi:           parsePercent(pick(columns.dpi)),
      gp_firm_hint:  pick(columns.gp_firm) ?? null,
    });
  }
  return out;
}
