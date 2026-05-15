// Productivity-app UI chrome that bleeds into "Print to PDF" exports.
// Centralised so pdf_parser.ts and vision_pdf.ts share one source of truth.

export const CHROME_LINE_PATTERNS: RegExp[] = [
  // Google Sheets menu bar (locale-stable English ordering).
  /^File\s+Edit\s+View\s+Insert\s+Format\s+Data\s+Tools/i,
  /^Menus\s+\d+%/i,
  /\bView only\b/i,
  /\bRead\s*-\s*only\b/i,
  // MS Excel ribbon.
  /^Home\s+Insert\s+(Page Layout|Draw)\s+(Page Layout\s+)?Formulas\s+Data\s+Review/i,
  /\bLast\s+modified\s+(seconds|minutes|hours|days)\s+ago\b/i,
  // Numbers / Apple iWork chrome.
  /^Table\s+\d+(\s+of\s+\d+)?$/i,
  // Standalone toolbar / button labels that get their own line.
  /^(Share|Comment|Comments|Editing|Suggesting|Viewing|Print|Download|All changes saved)$/i,
  /^Sign\s+in$/i,
  // Sheet tab strip artifacts (e.g. "Sheet1 Sheet2 +" footer row).
  /^(Sheet|Tab)\d+(\s+(Sheet|Tab)\d+)+(\s*\+)?$/i,
  // Generic page-number footer.
  /^Page\s+\d+(\s+of\s+\d+)?$/i,
  /^\d+\s*\/\s*\d+$/,
  // Generated-PDF watermarks.
  /^Generated\s+by\s+/i,
  /^Exported\s+(on|from)\s+/i,
];

/** A line is "chrome" if it's empty or matches any chrome pattern. */
export function isChromeText(text: string): boolean {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (!t) return true;
  return CHROME_LINE_PATTERNS.some((re) => re.test(t));
}
