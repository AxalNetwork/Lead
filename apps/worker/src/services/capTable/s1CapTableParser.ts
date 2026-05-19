// Task #5: S-1 Principal Stockholders table extractor.
//
// The "gold" extractor — IPO prospectuses publish a near-complete
// pre-IPO cap table in the "Principal Stockholders" / "Principal and
// Selling Stockholders" section. Layout is remarkably consistent across
// modern filings (Reddit S-1, Klaviyo S-1, Instacart S-1, Astera Labs
// S-1, …):
//
//   <table>
//     <caption|h2>Principal Stockholders</caption|h2>
//     <thead><tr><th>Name</th><th>Shares</th><th>%</th>...</tr></thead>
//     <tbody>
//       <tr><td>Steven Huffman</td><td>3,300,000</td><td>3.3%</td></tr>
//       ...
//     </tbody>
//   </table>
//
// We:
//   1. Strip <script>/<style>/comments.
//   2. Find every <table> following a heading containing the magic
//      phrase ("Principal Stockholders" OR "Beneficial Ownership of
//      Common Stock").
//   3. Score candidate tables by column-header match (name + shares + %
//      columns).
//   4. Parse the highest-scoring table row-by-row into HolderInput rows.
//   5. Detect total-row + footnotes (typically prefixed "*", "(†)", or
//      "Total"); fold totals into the summary and drop them from rows.

import type { CapTableHolderInput, CapTableSnapshotInput } from "./types";
import { classifyHolder, classifySecurity, parsePercent, parseShareCount } from "./normalize";

interface RawTable { caption: string; head: string[]; rows: string[][]; raw: string }

function stripScripts(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

function cellText(cell: string): string {
  return cell.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function parseRow(rowHtml: string): string[] {
  const cells: string[] = [];
  const re = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(rowHtml)) !== null) cells.push(cellText(m[1]));
  return cells;
}

function findCaption(html: string, tableIdx: number): string {
  // Walk backwards from tableIdx looking for the most recent <h*>/<p
  // class="caption">/<caption> tag.
  const window = html.slice(Math.max(0, tableIdx - 4000), tableIdx);
  const headings = [...window.matchAll(/<(?:h[1-6]|caption|div[^>]*caption[^>]*)\b[^>]*>([\s\S]*?)<\/(?:h[1-6]|caption|div)>/gi)];
  if (!headings.length) return "";
  const last = headings[headings.length - 1];
  return cellText(last[1]).slice(0, 200);
}

const CAP_TABLE_CAPTION_RE =
  /(principal\s+(?:and\s+selling\s+)?stockholders?|beneficial\s+owners?(?:hip)?(?:\s+of\s+common\s+stock)?|security\s+ownership\s+of\s+certain\s+beneficial\s+owners)/i;

const NAME_COL_RE = /(name|stockholder|beneficial\s+owner|holder)/i;
const SHARES_COL_RE = /\bshares?\b/i;
const PCT_COL_RE = /(%|percent|percentage)/i;

/** Row is "header-shaped" if its tag stream is dominated by <th>, OR
 *  no cell parses as a share-count / percentage. Real S-1s frequently
 *  stack 2–3 header rows ("Number of Shares Beneficially Owned" on row
 *  1 and "Number / %" on row 2); we merge them so the column-index
 *  scorer can find the right columns. */
function isHeaderRow(rowHtml: string, cells: string[]): boolean {
  const thCount = (rowHtml.match(/<th\b/gi) ?? []).length;
  const tdCount = (rowHtml.match(/<td\b/gi) ?? []).length;
  if (thCount > 0 && thCount >= tdCount) return true;
  if (!cells.length) return false;
  for (const c of cells) {
    if (!c) continue;
    if (parseShareCount(c) != null) return false;
    if (parsePercent(c) != null && c.includes("%") === false) return false;
  }
  return true;
}

function mergeHeaderRows(rows: string[][]): string[] {
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const out: string[] = [];
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    for (const r of rows) {
      const v = r[c];
      if (v && !parts.includes(v)) parts.push(v);
    }
    out.push(parts.join(" ").trim());
  }
  return out;
}

function tablesIn(html: string): RawTable[] {
  const out: RawTable[] = [];
  const tableRe = /<table\b[\s\S]*?<\/table>/gi;
  let m: RegExpExecArray | null;
  while ((m = tableRe.exec(html)) !== null) {
    const t = m[0];
    const idx = m.index;
    const caption = findCaption(html, idx);
    const rowsHtml = [...t.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((x) => x[1]);
    if (rowsHtml.length < 2) continue;
    // Detect a contiguous header block: rows 0..k-1 that are
    // header-shaped. We merge them column-wise so multi-row header
    // layouts ("Number / %" stacked below "Shares Beneficially Owned")
    // collapse into a single, searchable header row.
    const headerRows: string[][] = [];
    let k = 0;
    for (; k < rowsHtml.length && k < 4; k++) {
      const cells = parseRow(rowsHtml[k]);
      if (!isHeaderRow(rowsHtml[k], cells)) break;
      headerRows.push(cells);
    }
    if (!headerRows.length) {
      headerRows.push(parseRow(rowsHtml[0]));
      k = 1;
    }
    const head = mergeHeaderRows(headerRows);
    const body: string[][] = [];
    for (let i = k; i < rowsHtml.length; i++) {
      const cells = parseRow(rowsHtml[i]);
      if (cells.some((c) => c.length > 0)) body.push(cells);
    }
    out.push({ caption, head, rows: body, raw: t });
  }
  return out;
}

interface CandidateTable extends RawTable {
  score: number;
  nameIdx: number;
  sharesIdx: number;
  pctIdx: number;
}

function scoreTable(t: RawTable): CandidateTable | null {
  if (!t.head.length || t.rows.length < 2) return null;
  const lower = t.head.map((h) => h.toLowerCase());
  const nameIdx = lower.findIndex((h) => NAME_COL_RE.test(h));
  if (nameIdx < 0) return null;
  // Several S-1s split "Number of Shares Beneficially Owned" across two
  // sub-headers ("Number", "%"). We pick the first column matching each.
  const sharesIdx = lower.findIndex((h) => SHARES_COL_RE.test(h));
  const pctIdx = lower.findIndex((h, i) => i !== nameIdx && PCT_COL_RE.test(h));
  if (sharesIdx < 0 && pctIdx < 0) return null;
  let score = 0;
  if (CAP_TABLE_CAPTION_RE.test(t.caption)) score += 50;
  if (nameIdx >= 0) score += 10;
  if (sharesIdx >= 0) score += 15;
  if (pctIdx >= 0) score += 15;
  // Rows that look like (name, big-number, pct) push the score up.
  let dataishRows = 0;
  for (const r of t.rows) {
    if (r.length <= Math.max(nameIdx, sharesIdx, pctIdx)) continue;
    const name = r[nameIdx];
    if (!name || name.length < 2) continue;
    const sh = sharesIdx >= 0 ? parseShareCount(r[sharesIdx]) : null;
    const pc = pctIdx >= 0 ? parsePercent(r[pctIdx]) : null;
    if (sh != null || pc != null) dataishRows++;
  }
  score += dataishRows;
  if (dataishRows < 3) return null;
  return { ...t, score, nameIdx, sharesIdx, pctIdx };
}

function pickBestTable(html: string): CandidateTable | null {
  const tables = tablesIn(stripScripts(html));
  let best: CandidateTable | null = null;
  for (const t of tables) {
    const c = scoreTable(t);
    if (!c) continue;
    if (!best || c.score > best.score) best = c;
  }
  return best;
}

const TOTAL_ROW_RE = /\btotal\b|\bsum\b/i;
const FOOTNOTE_NAME_RE = /^[\s*†‡#§•\-—–]*$/;

export interface S1CapTableExtractResult {
  ok: boolean;
  reason?: string;
  snapshot: Omit<CapTableSnapshotInput, "company_name_raw" | "source_url" | "as_of" | "source_kind" | "source_accession_no"> | null;
  holders: CapTableHolderInput[];
  totals: { shares: number | null; pct: number | null };
}

/**
 * Extract a Principal-Stockholders table from S-1 HTML. Pure: no
 * network, no DB. Returns null fields when the table cannot be located
 * — the caller should fall back to the Form D inference path.
 */
export function extractS1CapTable(html: string): S1CapTableExtractResult {
  const best = pickBestTable(html);
  if (!best) return { ok: false, reason: "no_principal_stockholders_table", snapshot: null, holders: [], totals: { shares: null, pct: null } };

  const securityHint = classifySecurity(best.caption + " " + best.head.join(" "));
  const holders: CapTableHolderInput[] = [];
  let totalShares: number | null = null;
  let totalPct: number | null = null;
  for (const r of best.rows) {
    if (r.length <= best.nameIdx) continue;
    const rawName = r[best.nameIdx];
    if (!rawName || FOOTNOTE_NAME_RE.test(rawName)) continue;
    const shares = best.sharesIdx >= 0 ? parseShareCount(r[best.sharesIdx]) : null;
    const pct = best.pctIdx >= 0 ? parsePercent(r[best.pctIdx]) : null;
    if (TOTAL_ROW_RE.test(rawName)) {
      if (shares != null) totalShares = shares;
      if (pct != null) totalPct = pct;
      continue;
    }
    // Skip rows where neither shares nor pct parsed AND name doesn't
    // look like a real holder (likely a section divider).
    if (shares == null && pct == null && rawName.length < 4) continue;
    const security = classifySecurity(rawName + " " + best.caption);
    const cls = classifyHolder(rawName, security === "unknown" ? securityHint : security);
    holders.push({
      holder_name_raw: rawName.slice(0, 200),
      holder_class: cls,
      security_type: security === "unknown" ? (securityHint === "unknown" ? null : securityHint) : security,
      shares,
      pct_ownership: pct,
    });
  }
  if (holders.length < 3) {
    return { ok: false, reason: "too_few_holders", snapshot: null, holders, totals: { shares: totalShares, pct: totalPct } };
  }
  // Derive snapshot-level fields when we have a total row.
  const fdShares = (totalShares ?? (holders.reduce((a, h) => a + (h.shares ?? 0), 0) || null));
  let optionPoolPct: number | null = null;
  let preferredPct: number | null = null;
  let commonPct: number | null = null;
  let foundersSum = 0;
  let prefSum = 0;
  for (const h of holders) {
    if (h.holder_class === "employee_pool" || h.holder_class === "esop_unallocated") {
      optionPoolPct = (optionPoolPct ?? 0) + (h.pct_ownership ?? 0);
    } else if (h.holder_class === "preferred_investor") {
      prefSum += h.pct_ownership ?? 0;
    } else if (h.holder_class === "founder") {
      foundersSum += h.pct_ownership ?? 0;
    }
  }
  if (prefSum > 0) preferredPct = Math.min(1, prefSum);
  if (foundersSum > 0) commonPct = Math.min(1, foundersSum);
  if (optionPoolPct != null) optionPoolPct = Math.min(1, optionPoolPct);

  return {
    ok: true,
    snapshot: {
      fully_diluted_shares: fdShares,
      post_money_usd: null,                // S-1 itself doesn't disclose post-money pre-IPO; price/range comes from amendment
      pre_money_usd: null,
      option_pool_pct: optionPoolPct,
      preferred_pct: preferredPct,
      common_pct: commonPct,
      notes: best.caption ? `S-1 section: ${best.caption.slice(0, 120)}` : null,
      holders: [],                          // filled by caller in snapshot input
    },
    holders,
    totals: { shares: totalShares, pct: totalPct },
  };
}
