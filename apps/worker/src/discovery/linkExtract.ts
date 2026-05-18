// Task #3: cheap HTML link extractor used by the smart-frontier expander.
//
// Returns { url, anchor } for every <a href> in the document, resolved
// against the page URL. Deliberately lightweight (regex-based) — the
// page is already parsed by other extractors; this helper is for the
// frontier expander which only needs URL + anchor text.

export interface ExtractedLink {
  url: string;
  anchor: string | null;
}

const A_TAG_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

export function extractLinksFromHtml(baseUrl: string, html: string): ExtractedLink[] {
  if (!html) return [];
  const out: ExtractedLink[] = [];
  let m: RegExpExecArray | null;
  let base: URL;
  try { base = new URL(baseUrl); } catch { return []; }
  const seen = new Set<string>();
  while ((m = A_TAG_RE.exec(html)) && out.length < 2000) {
    const attrs = m[1] ?? "";
    const inner = m[2] ?? "";
    const hrefMatch = attrs.match(HREF_RE);
    if (!hrefMatch) continue;
    const href = (hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "").trim();
    if (!href) continue;
    if (/^(mailto:|tel:|javascript:|#)/i.test(href)) continue;
    let abs: string;
    try { abs = new URL(href, base).toString(); } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const anchor = inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    out.push({ url: abs, anchor: anchor || null });
  }
  return out;
}
