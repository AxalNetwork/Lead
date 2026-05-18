// PubMed article adapter.

import type { SiteAdapter, AdapterResult } from "./types";
import { pickMeta, pickTitle, stripTags } from "./_util";

export const pubmed: SiteAdapter = {
  id: "pubmed",
  priority: 75,
  hosts: ["pubmed.ncbi.nlm.nih.gov", "www.ncbi.nlm.nih.gov"],
  url_patterns: [/^\/\d+\/?$/, /\/pmc\/articles\//i],
  profile_types_emitted: ["research_scientist", "professor"],
  extract(html, url): AdapterResult {
    const title = pickMeta(html, "citation_title") || pickTitle(html);
    const authors: string[] = [];
    const authorRe = /<meta[^>]+name=["']citation_author["'][^>]+content=["']([^"']+)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = authorRe.exec(html))) authors.push(m[1]);
    const journal = pickMeta(html, "citation_journal_title");
    const date = pickMeta(html, "citation_date") || pickMeta(html, "citation_publication_date");
    const doi = pickMeta(html, "citation_doi");
    const abstractText = stripTags(html.match(/<div[^>]+class=["'][^"']*abstract[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] ?? "");
    return {
      adapter_id: "pubmed",
      confidence: (title && authors.length) ? 0.85 : 0.4,
      candidates: [{
        profile_type: null,
        confidence: (title && authors.length) ? 0.85 : 0.4,
        name: title || null,
        url,
        data: { title, authors, journal, date, doi, abstract: abstractText, pubmed_url: url },
      }],
      child_urls: [],
    };
  },
};
