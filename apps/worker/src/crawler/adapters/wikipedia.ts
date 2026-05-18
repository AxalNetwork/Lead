// Wikipedia article adapter. Parses the infobox + first paragraph; the
// detection signal that drives selection is a /wiki/ path on a known
// Wikipedia hostname.

import type { SiteAdapter, AdapterResult } from "./types";
import { stripTags, pickTitle, pickMeta } from "./_util";

function parseInfobox(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const tableMatch = html.match(/<table[^>]+class=["'][^"']*infobox[^"']*["'][^>]*>([\s\S]*?)<\/table>/i);
  if (!tableMatch) return out;
  const rows = tableMatch[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi);
  for (const row of rows) {
    const headerM = row[1].match(/<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/i);
    if (!headerM) continue;
    const key = stripTags(headerM[1]).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
    const val = stripTags(headerM[2]);
    if (key && val) out[key] = val;
  }
  return out;
}

export const wikipedia: SiteAdapter = {
  id: "wikipedia",
  priority: 75,
  hosts: ["en.wikipedia.org", "wikipedia.org", "en.m.wikipedia.org"],
  url_patterns: [/^\/wiki\/[^:]+/i],
  profile_types_emitted: ["firm_person", "founder", "investor_vc", "investor_pe", "public_company"],
  extract(html, url): AdapterResult {
    const title = pickMeta(html, "og:title") || pickTitle(html).replace(/\s*-\s*Wikipedia.*$/, "").trim();
    const description = pickMeta(html, "og:description") || "";
    const infobox = parseInfobox(html);
    const text = stripTags(html);
    const firstPara = text.split(/\.\s+/).slice(0, 3).join(". ").trim() + ".";
    const isPerson = !!(infobox.born || infobox.birth_date || /\bborn\s+(?:\d|\w+\s+\d)/i.test(text));
    const isCompany = !!(infobox.founded || infobox.industry || infobox.headquarters || infobox.type);
    return {
      adapter_id: "wikipedia",
      confidence: (isPerson || isCompany) ? 0.75 : 0.4,
      candidates: [{
        profile_type: isPerson ? "firm_person" : null,
        confidence: (isPerson || isCompany) ? 0.75 : 0.4,
        name: title || null,
        url,
        data: {
          name: title,
          description: description || firstPara,
          infobox,
          is_person: isPerson, is_company: isCompany,
          wikipedia_url: url,
        },
      }],
      child_urls: [],
    };
  },
};
