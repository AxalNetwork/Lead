// Task #13: Document classifier.
//
// Routes an uploaded document to one of:
//   pitch_deck | financial_model | safe | term_sheet |
//   shareholder_agreement | commercial_contract | nda | unknown
//
// Heuristic-only at v1: mime + filename + first-page keyword density.
// No LLM call here so classification stays cheap and offline-testable.

export type DocumentKind =
  | "pitch_deck"
  | "financial_model"
  | "safe"
  | "term_sheet"
  | "shareholder_agreement"
  | "commercial_contract"
  | "nda"
  | "unknown";

export interface ClassificationInput {
  filename: string;
  mime?: string | null;
  /** First-page or first-N-chars text (after PDF text extraction or XLSX
   *  sheet-name concatenation). Empty string is acceptable. */
  sampleText: string;
}

export interface ClassificationResult {
  kind: DocumentKind;
  confidence: number;
  reasons: string[];
}

const SPREADSHEET_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
]);

const SLIDE_MIMES = new Set([
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.presentation",
]);

function hasAny(text: string, needles: string[]): number {
  const lower = text.toLowerCase();
  let n = 0;
  for (const k of needles) if (lower.includes(k)) n++;
  return n;
}

export function classifyDocument(input: ClassificationInput): ClassificationResult {
  const filename = input.filename.toLowerCase();
  const mime = (input.mime ?? "").toLowerCase();
  const text = input.sampleText ?? "";
  const reasons: string[] = [];

  // ---- Strong filename signals ----
  if (/\bsafe\b/.test(filename) || filename.includes("simple agreement for future equity")) {
    reasons.push("filename:safe");
    return { kind: "safe", confidence: 0.9, reasons };
  }
  if (filename.includes("term-sheet") || filename.includes("termsheet") || filename.includes("term_sheet")) {
    reasons.push("filename:term_sheet");
    return { kind: "term_sheet", confidence: 0.9, reasons };
  }
  if (filename.includes("nda") || filename.includes("non-disclosure")) {
    reasons.push("filename:nda");
    return { kind: "nda", confidence: 0.85, reasons };
  }
  if (filename.includes("shareholder") || filename.includes("sha-") || filename.endsWith("sha.pdf")) {
    reasons.push("filename:sha");
    return { kind: "shareholder_agreement", confidence: 0.85, reasons };
  }
  if (filename.includes("pitch") || filename.includes("deck")) {
    reasons.push("filename:pitch_deck");
    return { kind: "pitch_deck", confidence: 0.85, reasons };
  }
  if (filename.includes("model") || filename.includes("financial") || filename.includes("budget")) {
    reasons.push("filename:financial_model");
    return { kind: "financial_model", confidence: 0.8, reasons };
  }

  // ---- Strong mime signals ----
  if (SPREADSHEET_MIMES.has(mime) || /\.(xlsx?|csv|ods)$/i.test(filename)) {
    reasons.push("mime:spreadsheet");
    return { kind: "financial_model", confidence: 0.7, reasons };
  }
  if (SLIDE_MIMES.has(mime) || /\.pptx?$/i.test(filename)) {
    reasons.push("mime:slide");
    return { kind: "pitch_deck", confidence: 0.75, reasons };
  }

  // ---- Text keyword density ----
  const safeHits = hasAny(text, [
    "simple agreement for future equity", "post-money safe", "valuation cap",
    "discount rate", "mfn", "most favored nation",
  ]);
  const tsHits = hasAny(text, [
    "term sheet", "pre-money valuation", "post-money valuation",
    "liquidation preference", "pro rata", "anti-dilution", "board composition",
  ]);
  const shaHits = hasAny(text, [
    "shareholders agreement", "drag-along", "drag along", "tag-along", "tag along",
    "right of first refusal", "rofr", "preemptive right",
  ]);
  const ndaHits = hasAny(text, [
    "non-disclosure agreement", "confidential information", "confidentiality agreement",
    "nondisclosure", "mutual nda",
  ]);
  const contractHits = hasAny(text, [
    "master services agreement", "msa", "statement of work", "sow",
    "annual contract value", "auto-renew", "subscription agreement",
  ]);
  const deckHits = hasAny(text, [
    "problem", "solution", "market size", "tam", "go-to-market",
    "traction", "team", "the ask",
  ]);
  const modelHits = hasAny(text, [
    "arr", "mrr", "burn rate", "runway", "revenue forecast", "headcount plan", "p&l",
  ]);

  const scored: Array<[DocumentKind, number]> = [
    ["safe", safeHits * 2],
    ["term_sheet", tsHits],
    ["shareholder_agreement", shaHits],
    ["nda", ndaHits],
    ["commercial_contract", contractHits],
    ["pitch_deck", deckHits],
    ["financial_model", modelHits],
  ];
  scored.sort((a, b) => b[1] - a[1]);
  const [topKind, topScore] = scored[0];
  if (topScore >= 2) {
    reasons.push(`keywords:${topKind}:${topScore}`);
    const conf = Math.min(0.85, 0.4 + topScore * 0.1);
    return { kind: topKind, confidence: conf, reasons };
  }
  reasons.push("no_strong_signal");
  return { kind: "unknown", confidence: 0.2, reasons };
}
