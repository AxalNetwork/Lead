// Classify an upload by extension + MIME + magic bytes + URL hints.

export type UploadFormat =
  | "csv" | "tsv" | "xlsx" | "xls" | "ods"
  | "pdf-text" | "pdf-image"
  | "image"
  | "html"
  | "gsheet" | "airtable"
  | "unknown";

export interface FormatHint { ext?: string; mime?: string | null; url?: string | null }

/** Filename + MIME-only classification (no byte sniffing). */
export function detectFormat(h: FormatHint): UploadFormat {
  const ext = (h.ext || "").toLowerCase();
  const mime = (h.mime || "").toLowerCase();
  const url = (h.url || "").toLowerCase();
  if (url.includes("docs.google.com/spreadsheets")) return "gsheet";
  if (url.includes("airtable.com")) return "airtable";
  if (ext === "csv" || mime.includes("text/csv")) return "csv";
  if (ext === "tsv" || mime.includes("text/tab-separated")) return "tsv";
  if (ext === "xlsx" || mime.includes("openxmlformats-officedocument.spreadsheetml")) return "xlsx";
  if (ext === "xls" || mime.includes("ms-excel")) return "xls";
  if (ext === "ods" || mime.includes("opendocument.spreadsheet")) return "ods";
  if (ext === "pdf" || mime.includes("pdf")) return "pdf-text";  // upgrade to pdf-image after parse if text density is low
  if (ext === "png" || ext === "jpg" || ext === "jpeg" || ext === "webp" || ext === "tiff" || ext === "bmp" || mime.startsWith("image/")) return "image";
  if (ext === "html" || ext === "htm" || mime.includes("html")) return "html";
  return "unknown";
}

/** Average text characters per page below this threshold flips a PDF to image-mode. */
export const IMAGE_PDF_DENSITY = 50;
