// Tiny dependency-free HTML helpers shared by the parsers. We deliberately
// avoid pulling in cheerio/linkedom for the minimal acceptance; the same API
// shape lets parsers swap in a real DOM later without changing call sites.

const TAG_RE = /<\/?[^>]+>/g;
const SCRIPT_STYLE_RE = /<(script|style)[^>]*>[\s\S]*?<\/\1>/gi;
const WHITESPACE_RE = /\s+/g;

const ANCHOR_RE = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
const HREF_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const TITLE_RE = /<title[^>]*>([\s\S]*?)<\/title>/i;

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const MAILTO_RE = /^mailto:/i;

export interface Anchor {
  href: string;
  text: string;
  rel?: string;
}

export function stripTags(html: string): string {
  return html.replace(SCRIPT_STYLE_RE, " ").replace(TAG_RE, " ").replace(WHITESPACE_RE, " ").trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function extractTitle(html: string): string | null {
  const m = TITLE_RE.exec(html);
  return m ? decodeEntities(stripTags(m[1])) : null;
}

export function extractAnchors(html: string, baseUrl?: string): Anchor[] {
  const out: Anchor[] = [];
  ANCHOR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ANCHOR_RE.exec(html)) !== null) {
    const attrs = m[1];
    const inner = m[2];
    const hrefMatch = HREF_RE.exec(attrs);
    if (!hrefMatch) continue;
    const rawHref = hrefMatch[1] ?? hrefMatch[2] ?? hrefMatch[3] ?? "";
    if (!rawHref) continue;
    let href = decodeEntities(rawHref).trim();
    if (baseUrl) {
      try {
        href = new URL(href, baseUrl).toString();
      } catch {
        // leave as-is
      }
    }
    const text = decodeEntities(stripTags(inner));
    out.push({ href, text });
  }
  return out;
}

export function extractEmails(html: string): string[] {
  const set = new Set<string>();
  // Scan plaintext (after stripping tags)
  for (const m of stripTags(html).matchAll(EMAIL_RE)) set.add(m[0].toLowerCase());
  // Scan mailto: hrefs
  for (const a of extractAnchors(html)) {
    if (MAILTO_RE.test(a.href)) {
      const e = a.href.replace(MAILTO_RE, "").split("?")[0];
      if (e) set.add(e.toLowerCase());
    }
  }
  return [...set];
}

const SOCIAL_HOSTS: Record<string, string> = {
  "linkedin.com": "linkedin",
  "x.com": "twitter",
  "twitter.com": "twitter",
  "github.com": "github",
  "instagram.com": "instagram",
  "facebook.com": "facebook",
  "youtube.com": "youtube",
  "tiktok.com": "tiktok",
  "threads.net": "threads",
  "bsky.app": "bluesky",
  "mastodon.social": "mastodon",
};

export interface SocialLink {
  platform: string;
  url: string;
}

export function extractSocialLinks(html: string, baseUrl?: string): SocialLink[] {
  const out: SocialLink[] = [];
  const seen = new Set<string>();
  for (const a of extractAnchors(html, baseUrl)) {
    let host: string;
    try {
      host = new URL(a.href).hostname.toLowerCase().replace(/^www\./, "");
    } catch {
      continue;
    }
    for (const [domain, platform] of Object.entries(SOCIAL_HOSTS)) {
      if (host === domain || host.endsWith(`.${domain}`)) {
        const key = `${platform}|${a.href.toLowerCase()}`;
        if (seen.has(key)) break;
        seen.add(key);
        out.push({ platform, url: a.href });
        break;
      }
    }
  }
  return out;
}
