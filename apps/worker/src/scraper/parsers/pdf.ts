import type { ParsedLead } from "../../types";
import { extractDomain } from "../normalize";

/**
 * PDF text extraction. Uses pdfjs-dist when available (loaded dynamically so
 * the dependency stays optional in workers), then runs the same email/name
 * regex pass as the generic HTML parser. Returns an empty array when the
 * binary content cannot be parsed.
 *
 * The caller is responsible for sniffing Content-Type and feeding us the raw
 * bytes, since the standard fetcher returns text strings.
 */
export async function parsePdf(bytes: ArrayBuffer, sourceUrl: string): Promise<ParsedLead[]> {
  const text = await extractText(bytes);
  if (!text) return [];
  const domain = extractDomain(sourceUrl) ?? "";
  return extractLeadsFromText(text, sourceUrl, domain);
}

async function extractText(bytes: ArrayBuffer): Promise<string | null> {
  try {
    // Indirected specifier so tsc doesn't try to resolve the optional dep at
    // build time. pdfjs-dist is a runtime-optional dependency: workers without
    // the module installed simply skip PDF extraction and return [].
    const specifier = "pdfjs-dist/legacy/build/pdf.mjs";
    const mod = (await import(/* @vite-ignore */ specifier).catch(() => null)) as
      | {
          getDocument: (opts: { data: Uint8Array }) => { promise: Promise<PdfDoc> };
        }
      | null;
    if (!mod) return null;
    const doc = await mod.getDocument({ data: new Uint8Array(bytes) }).promise;
    const parts: string[] = [];
    const pages = Math.min(doc.numPages, 50);
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (item && typeof (item as { str?: unknown }).str === "string") {
          parts.push((item as { str: string }).str);
        }
      }
      parts.push("\n");
    }
    return parts.join(" ");
  } catch {
    return null;
  }
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const NAME_NEAR_EMAIL_RE = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,2})\s*[—\-–|·,]?\s*([A-Z][\w\s,&]{2,60})?\s*[\s\S]{0,80}?([A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,})/g;

function extractLeadsFromText(text: string, sourceUrl: string, sourceDomain: string): ParsedLead[] {
  const out: ParsedLead[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = NAME_NEAR_EMAIL_RE.exec(text))) {
    const email = m[3].toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({
      source_domain: sourceDomain,
      source_url: sourceUrl,
      name: m[1],
      title: m[2]?.trim() || undefined,
      email,
      meta: { from: "pdf" },
    });
  }
  // Catch any standalone emails missed by the name-bearing pattern.
  const stand = text.match(EMAIL_RE) ?? [];
  for (const e of stand) {
    const email = e.toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    out.push({
      source_domain: sourceDomain,
      source_url: sourceUrl,
      email,
      meta: { from: "pdf" },
    });
  }
  return out;
}

interface PdfDoc {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
}
interface PdfPage {
  getTextContent(): Promise<{ items: Array<unknown> }>;
}
