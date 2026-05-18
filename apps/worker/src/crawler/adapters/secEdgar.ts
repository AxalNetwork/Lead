// SEC EDGAR adapter. Handles three URL shapes:
//   - Company filing index pages (/cgi-bin/browse-edgar?...&CIK=...)
//   - Individual filing index pages (/Archives/edgar/data/{cik}/{acc-nodash}/...)
//   - Full-text search result pages (efts.sec.gov, /cgi-bin/srqsb)
// Pure HTML extraction; no API calls.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { stripTags, pickTitle, collectLinks } from "./_util";

const FORM_RE = /\b(10-K|10-Q|8-K|S-1|S-3|13F|13D|13G|Form\s*4|Form\s*ADV|Form\s*D|N-PX|N-CSR)\b/i;
const CIK_RE = /CIK=(\d+)/i;

export const secEdgar: SiteAdapter = {
  id: "sec_edgar",
  priority: 88,
  hosts: ["sec.gov", "www.sec.gov", "efts.sec.gov"],
  url_patterns: [
    /\/cgi-bin\/browse-edgar/i,
    /\/Archives\/edgar\/data\//i,
    /\/cgi-bin\/srqsb/i,
    /\/edgar\/searchedgar\//i,
  ],
  profile_types_emitted: ["public_company", "investor_vc", "investor_pe", "investor_pension", "fund_of_funds"],
  extract(html, url): AdapterResult {
    const title = pickTitle(html);
    const text = stripTags(html);
    const cik = CIK_RE.exec(url)?.[1] ?? CIK_RE.exec(html)?.[1] ?? null;
    const formMatch = FORM_RE.exec(title) ?? FORM_RE.exec(text);
    const form = formMatch ? formMatch[1].toUpperCase().replace(/\s+/g, "") : null;

    // Pull the registrant name from EDGAR's standard "Company Name" cell.
    const nameMatch = html.match(/Company Name[^<]*<\/[^>]+>\s*<[^>]+>\s*<a[^>]*>([^<]+)<\/a>/i)
      ?? html.match(/<span class="companyName">\s*([^<&]+)/i)
      ?? title.match(/^([^|<]+?)\s*[-|]\s*SEC/i);
    const name = nameMatch ? String(nameMatch[1]).trim() : (title || null);

    // Extract filing rows when present (Archives listing pages have a table).
    const filings: Array<{ form: string; date: string | null; href: string | null }> = [];
    const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let row: RegExpExecArray | null;
    while ((row = rowRe.exec(html))) {
      const rowHtml = row[1];
      const fM = FORM_RE.exec(stripTags(rowHtml));
      if (!fM) continue;
      const date = stripTags(rowHtml).match(/\b(20\d{2}-\d{2}-\d{2}|19\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null;
      const href = rowHtml.match(/<a\s+[^>]*href=["']([^"']+)["']/i)?.[1] ?? null;
      filings.push({ form: fM[1].toUpperCase().replace(/\s+/g, ""), date, href });
      if (filings.length >= 25) break;
    }

    const child = collectLinks(html, url)
      .filter((u) => /\/Archives\/edgar\/data\//i.test(u) || /\/cgi-bin\/browse-edgar/i.test(u))
      .slice(0, 50);

    const candidate: AdapterCandidate = {
      profile_type: form === "13F" ? "investor_vc" : form && /S-1|10-K|10-Q|8-K/.test(form) ? "public_company" : null,
      confidence: cik ? 0.8 : (name ? 0.5 : 0.3),
      name,
      url,
      data: {
        registrant_name: name,
        cik, form, filings,
        filing_count: filings.length,
        edgar_url: url,
      },
    };
    return { adapter_id: "sec_edgar", confidence: candidate.confidence, candidates: [candidate], child_urls: child };
  },
};
