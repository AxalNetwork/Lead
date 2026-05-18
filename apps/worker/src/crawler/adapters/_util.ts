// Shared helpers for site adapters. Kept tiny and dependency-free so
// adapters stay pure CPU.

export function stripTags(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function pickTitle(html: string): string {
  const m = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  return m ? m[1].trim() : "";
}

export function pickMeta(html: string, name: string): string | null {
  const re = new RegExp(
    `<meta\\s+[^>]*(?:name|property)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'][^>]*content=["']([^"']*)["']`,
    "i",
  );
  const m = html.match(re);
  return m ? m[1] : null;
}

export function parseNextData(html: string): unknown | null {
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export function parseAllJsonLd(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1].trim());
      if (Array.isArray(j)) out.push(...j as Array<Record<string, unknown>>);
      else if (j && typeof j === "object") out.push(j as Record<string, unknown>);
    } catch { /* skip malformed block */ }
  }
  return out;
}

/** Collect all <a href="..."> targets, resolved against base. */
export function collectLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const re = /<a\b[^>]*\bhref=["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  let base: URL | null = null;
  try { base = new URL(baseUrl); } catch { /* ignore */ }
  while ((m = re.exec(html))) {
    const href = m[1].trim();
    if (!href || href.startsWith("javascript:") || href.startsWith("mailto:")) continue;
    try {
      const u = base ? new URL(href, base) : new URL(href);
      out.add(u.toString().split("#")[0]);
    } catch { /* skip */ }
  }
  return [...out];
}

/** Walk a deeply-nested object looking for the first node passing `pred`. */
export function digFor<T>(obj: unknown, pred: (n: Record<string, unknown>) => boolean, depth = 0): T | null {
  if (!obj || typeof obj !== "object" || depth > 10) return null;
  const o = obj as Record<string, unknown>;
  if (pred(o)) return o as unknown as T;
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = digFor<T>(item, pred, depth + 1);
        if (hit) return hit;
      }
    } else if (v && typeof v === "object") {
      const hit = digFor<T>(v, pred, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/** Like digFor, but collects every match (deduped by reference). */
export function digAll<T>(obj: unknown, pred: (n: Record<string, unknown>) => boolean, depth = 0, out: T[] = []): T[] {
  if (!obj || typeof obj !== "object" || depth > 10) return out;
  const o = obj as Record<string, unknown>;
  if (pred(o)) out.push(o as unknown as T);
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) {
      for (const item of v) digAll<T>(item, pred, depth + 1, out);
    } else if (v && typeof v === "object") {
      digAll<T>(v, pred, depth + 1, out);
    }
  }
  return out;
}

export function safeHost(url: string): string {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** True when `urlStr`'s host equals `host` or is a subdomain of it.
 *  Strict equality / dot-boundary check — never substring includes(),
 *  to keep frontier expansion from leaking to look-alike domains. */
export function isSameRegistrableHost(urlStr: string, host: string): boolean {
  const h = safeHost(urlStr);
  if (!h) return false;
  const root = host.toLowerCase().replace(/^www\./, "");
  return h === root || h === `www.${root}` || h.endsWith(`.${root}`);
}
