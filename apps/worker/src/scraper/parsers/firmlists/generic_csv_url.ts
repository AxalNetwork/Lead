import type { Env } from "../../../types";
import type { FirmCandidate, FirmlistImportResult } from "./types";
import { rowToCandidate } from "./_helpers";

/**
 * Generic CSV / TSV URL importer.
 *
 * Streams the file (well, fetches; Worker memory is fine for typical firm
 * lists — caller is responsible for not pointing at a 10GB file), detects
 * the delimiter, and parses with a small RFC-4180-ish parser.
 */
export async function importFirms(url: string, _env: Env): Promise<FirmlistImportResult> {
  const res = await fetch(url, { headers: { Accept: "text/csv,text/tab-separated-values,*/*" } });
  if (!res.ok) return { firms: [], totalSeen: 0, errors: [`status_${res.status}`] };
  const text = await res.text();
  const delimiter = sniffDelimiter(text);
  const rows = parseDelimited(text, delimiter);
  if (rows.length < 2) return { firms: [], totalSeen: 0, errors: ["empty_or_header_only"] };

  const headers = rows[0];
  const firms: FirmCandidate[] = [];
  let seen = 0;
  for (let i = 1; i < rows.length; i++) {
    seen += 1;
    const r = rows[i];
    if (!r.length || r.every((c) => !c)) continue;
    const o: Record<string, unknown> = {};
    for (let j = 0; j < headers.length && j < r.length; j++) {
      const h = headers[j];
      const v = r[j];
      if (h && v !== "" && v != null) o[h] = v;
    }
    const cand = rowToCandidate(o, url);
    if (cand) firms.push(cand.candidate);
  }
  return { firms, totalSeen: seen };
}

function sniffDelimiter(sample: string): string {
  const firstLine = sample.split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = {
    ",": (firstLine.match(/,/g) || []).length,
    "\t": (firstLine.match(/\t/g) || []).length,
    ";": (firstLine.match(/;/g) || []).length,
    "|": (firstLine.match(/\|/g) || []).length,
  };
  let best = ",";
  let max = 0;
  for (const [d, c] of Object.entries(counts)) {
    if (c > max) { best = d; max = c; }
  }
  return best;
}

/** Minimal RFC-4180 delimited parser (handles "" escapes inside quoted fields). */
export function parseDelimited(input: string, delim: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < input.length) {
    const ch = input[i];
    if (inQuotes) {
      if (ch === '"') {
        if (input[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += ch; i += 1; continue;
    }
    if (ch === '"') { inQuotes = true; i += 1; continue; }
    if (ch === delim) { row.push(field); field = ""; i += 1; continue; }
    if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 1; continue; }
    if (ch === "\r") {
      // Swallow standalone \r; CRLF gets handled by the \n branch on the next char.
      if (input[i + 1] === "\n") { row.push(field); rows.push(row); row = []; field = ""; i += 2; continue; }
      i += 1; continue;
    }
    field += ch; i += 1;
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
