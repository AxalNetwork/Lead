// arXiv preprint adapter.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickMeta, pickTitle, stripTags } from "./_util";

export const arxiv: SiteAdapter = {
  id: "arxiv",
  priority: 75,
  hosts: ["arxiv.org", "www.arxiv.org"],
  url_patterns: [/^\/abs\/\d{4}\.\d{4,5}/i, /^\/pdf\/\d{4}\.\d{4,5}/i],
  profile_types_emitted: ["research_scientist", "phd_student", "postdoc"],
  extract(html, url): AdapterResult {
    const arxivId = url.match(/(\d{4}\.\d{4,5})/)?.[1] ?? null;
    const title = pickMeta(html, "citation_title") || pickTitle(html).replace(/^\[\d{4}\.\d{4,5}\]\s*/, "");
    const authors: string[] = [];
    const authorRe = /<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = authorRe.exec(html))) authors.push(m[1]);
    const abstractText = stripTags(html.match(/<blockquote[^>]+class=["']abstract[^"']*["'][^>]*>([\s\S]*?)<\/blockquote>/i)?.[1] ?? "");
    const subjects = pickMeta(html, "citation_arxiv_id") ? (html.match(/Subjects?:<\/td>\s*<td[^>]*>([^<]+)/)?.[1]?.trim() ?? null) : null;
    return {
      adapter_id: "arxiv",
      confidence: arxivId ? 0.85 : 0.4,
      candidates: [{
        profile_type: null,
        confidence: arxivId ? 0.85 : 0.4,
        name: title || null,
        url,
        data: { arxiv_id: arxivId, title, authors, abstract: abstractText, subjects, arxiv_url: url },
      }],
      child_urls: [],
    };
  },
};
