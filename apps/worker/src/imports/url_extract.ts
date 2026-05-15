// Pull every URL-shaped string out of a row collection. We scan all cell
// values rather than just "URL" columns so that thesis/notes free-text
// links are captured too.

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/gi;

export function extractUrlsFromRows(rows: Array<Record<string, string>>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of rows) {
    for (const v of Object.values(row)) {
      if (!v) continue;
      const s = String(v);
      // Bare-domain heuristic: `acme.vc` in a "Website" column should also
      // become a URL. Only lift a single-token bare host (no spaces).
      if (!URL_RE.test(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[\S]*)?$/i.test(s.trim())) {
        const u = `https://${s.trim().replace(/^\/\//, "")}`;
        const k = u.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(u); }
        URL_RE.lastIndex = 0;
        continue;
      }
      URL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = URL_RE.exec(s)) !== null) {
        const u = m[0].replace(/[.,;:]+$/, "");
        const k = u.toLowerCase();
        if (!seen.has(k)) { seen.add(k); out.push(u); }
      }
    }
  }
  return out;
}

export function classifyUrl(url: string): "firmlist" | "profile" | "url" {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch { return "url"; }
  if (/(^|\.)(linkedin|twitter|x|crunchbase|github|angel\.co)\.com$/.test(host)) return "profile";
  if (/(airtable|docs\.google\.com|openvc|mercury|signal\.nfx)/.test(host + url)) return "firmlist";
  return "url";
}
