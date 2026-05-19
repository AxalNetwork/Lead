// Task #13: Extractor router.
//
// Maps a classified DocumentKind to the matching per-format extractor
// and returns a normalized DocumentExtraction envelope. Caller (the
// persist layer) is responsible for writing the envelope into
// document_extractions and mirroring derived facts via insertFact.

import { redactPii, type RedactionCounts } from "./pii";
import type { DocumentKind } from "./classifier";
import { extractSafe, SAFE_EXTRACTOR_VERSION } from "./extractors/safe";
import { extractTermSheet, TERM_SHEET_EXTRACTOR_VERSION } from "./extractors/termSheet";
import { extractSha, SHA_EXTRACTOR_VERSION } from "./extractors/sha";
import { extractCommercial, COMMERCIAL_EXTRACTOR_VERSION } from "./extractors/commercial";
import { extractNda, NDA_EXTRACTOR_VERSION } from "./extractors/nda";
import { extractPitchDeck, PITCH_DECK_EXTRACTOR_VERSION } from "./extractors/pitchDeck";
import { extractFinancialModel, FINANCIAL_MODEL_EXTRACTOR_VERSION, type Sheet } from "./extractors/financialModel";

export interface ExtractorInput {
  kind: DocumentKind;
  /** Plain text view of the doc (already OCR'd / pdfjs-extracted). */
  text: string;
  /** XLSX-derived sheets (only required for financial_model). */
  sheets?: Sheet[];
  /** When true, the caller is opting in to send raw text to the LLM. */
  allowRawText: boolean;
}

export interface ExtractorEnvelope {
  kind: DocumentKind;
  extractor_name: string;
  extractor_version: string;
  confidence: number;
  payload: unknown;
  redaction_applied: boolean;
  redaction_counts: RedactionCounts | null;
  warnings: string[];
}

const EMPTY_COUNTS: RedactionCounts = {
  email: 0, ssn: 0, itin: 0, us_bank_account: 0, iban: 0, phone: 0, credit_card: 0,
};

export function runExtractor(input: ExtractorInput): ExtractorEnvelope {
  // PII pre-pass: every extractor receives redacted text by default.
  // Regex extractors don't need PII, so this is purely defense-in-depth
  // for the case where a future extractor adds an LLM call. The raw-
  // text override flag lets a user bypass when needed.
  const redaction = input.allowRawText
    ? { text: input.text, counts: EMPTY_COUNTS, total: 0 }
    : redactPii(input.text);
  const text = redaction.text;
  const redaction_applied = !input.allowRawText;
  const redaction_counts = input.allowRawText ? null : redaction.counts;

  switch (input.kind) {
    case "safe": {
      const payload = extractSafe(text);
      const confidence = payload.warnings.length === 0 ? 0.85 : 0.55;
      return {
        kind: "safe", extractor_name: "safeParser", extractor_version: SAFE_EXTRACTOR_VERSION,
        confidence, payload, redaction_applied, redaction_counts, warnings: payload.warnings,
      };
    }
    case "term_sheet": {
      const payload = extractTermSheet(text);
      const confidence = payload.warnings.length === 0 ? 0.8 : 0.5;
      return {
        kind: "term_sheet", extractor_name: "termSheetParser", extractor_version: TERM_SHEET_EXTRACTOR_VERSION,
        confidence, payload, redaction_applied, redaction_counts, warnings: payload.warnings,
      };
    }
    case "shareholder_agreement": {
      const payload = extractSha(text);
      const confidence = payload.warnings.length === 0 ? 0.75 : 0.5;
      return {
        kind: "shareholder_agreement", extractor_name: "shareholderAgreementParser", extractor_version: SHA_EXTRACTOR_VERSION,
        confidence, payload, redaction_applied, redaction_counts, warnings: payload.warnings,
      };
    }
    case "commercial_contract": {
      const payload = extractCommercial(text);
      const confidence = payload.warnings.length === 0 ? 0.75 : 0.5;
      return {
        kind: "commercial_contract", extractor_name: "commercialContractParser", extractor_version: COMMERCIAL_EXTRACTOR_VERSION,
        confidence, payload, redaction_applied, redaction_counts, warnings: payload.warnings,
      };
    }
    case "nda": {
      const payload = extractNda(text);
      const confidence = payload.warnings.length === 0 ? 0.7 : 0.5;
      return {
        kind: "nda", extractor_name: "ndaParser", extractor_version: NDA_EXTRACTOR_VERSION,
        confidence, payload, redaction_applied, redaction_counts, warnings: payload.warnings,
      };
    }
    case "pitch_deck": {
      const payload = extractPitchDeck(text);
      const confidence = payload.warnings.length === 0 ? 0.7 : 0.45;
      return {
        kind: "pitch_deck", extractor_name: "pitchDeckExtractor", extractor_version: PITCH_DECK_EXTRACTOR_VERSION,
        confidence, payload, redaction_applied, redaction_counts, warnings: payload.warnings,
      };
    }
    case "financial_model": {
      const payload = extractFinancialModel(input.sheets ?? []);
      const confidence = payload.warnings.length === 0 ? 0.7 : 0.45;
      return {
        kind: "financial_model", extractor_name: "financialModelExtractor", extractor_version: FINANCIAL_MODEL_EXTRACTOR_VERSION,
        confidence, payload, redaction_applied, redaction_counts, warnings: payload.warnings,
      };
    }
    default:
      return {
        kind: "unknown", extractor_name: "noop", extractor_version: "1.0.0",
        confidence: 0.1, payload: { reason: "unknown_kind" },
        redaction_applied, redaction_counts, warnings: ["unknown_kind"],
      };
  }
}
