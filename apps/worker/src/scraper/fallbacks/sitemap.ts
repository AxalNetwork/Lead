/**
 * Sitemap / feed / team-page mining. Run once per newly-discovered source
 * domain to enqueue likely team / about / people pages and any URLs found in
 * the canonical sitemap.xml.
 */

const TEAM_PATHS = [
  "/team",
  "/team/",
  "/about",
  "/about/",
  "/about-us",
  "/people",
  "/people/",
  "/our-team",
  "/leadership",
  "/partners",
  "/portfolio",
];

const TEAM_RE = /\/(team|about|about-us|people|our-team|leadership|partners|portfolio)(?:\/|$)/i;

export interface DiscoveredUrls {
  /** Direct guesses based on common URL conventions. */
  guessed: string[];
  /** URLs extracted from sitemap.xml that look like team/about pages. */
  fromSitemap: string[];
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "AIDataSignalBot/1.0 (+https://aidatasignal.com)" },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/** Extract <loc> URLs from a sitemap or sitemap-index document. */
function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>([^<]+)<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    out.push(m[1].trim());
    if (out.length > 5000) break;
  }
  return out;
}

export async function discoverUrls(seedUrl: string): Promise<DiscoveredUrls> {
  const origin = originOf(seedUrl);
  if (!origin) return { guessed: [], fromSitemap: [] };

  const guessed = TEAM_PATHS.map((p) => `${origin}${p}`);

  const fromSitemap: string[] = [];
  const sitemapXml = (await fetchText(`${origin}/sitemap.xml`)) ?? (await fetchText(`${origin}/sitemap_index.xml`));
  if (sitemapXml) {
    const locs = extractLocs(sitemapXml);
    // If this is a sitemap index, fan out one level.
    const childSitemaps = locs.filter((u) => /sitemap.*\.xml$/i.test(u)).slice(0, 5);
    const pageLocs = locs.filter((u) => !/sitemap.*\.xml$/i.test(u));
    for (const c of childSitemaps) {
      const child = await fetchText(c);
      if (child) pageLocs.push(...extractLocs(child));
    }
    for (const u of pageLocs) {
      if (TEAM_RE.test(u)) fromSitemap.push(u);
      if (fromSitemap.length >= 50) break;
    }
  }

  return { guessed, fromSitemap };
}
