import type { ParsedLead } from "../../types";
import { extractDomain } from "../normalize";
import { extractTitle, extractSocialLinks, stripTags } from "../html";

export function parse(html: string, url: string): ParsedLead[] {
  const source_domain = extractDomain(url);
  const title = extractTitle(html);
  const text = stripTags(html);
  // Crunchbase pages have very predictable title shape: "Person Name - Job, Org | Crunchbase"
  let name: string | undefined;
  let position: string | undefined;
  let org: string | undefined;
  if (title) {
    const m = /^([^-|]+?)\s*-\s*([^|]+?)(?:\s*\|\s*Crunchbase)?$/.exec(title);
    if (m) {
      name = m[1].trim();
      const tail = m[2].trim();
      const parts = tail.split(",").map((s) => s.trim());
      position = parts[0];
      org = parts[1];
    } else {
      name = title.replace(/\s*\|\s*Crunchbase.*$/i, "").trim();
    }
  }
  return [
    {
      source_domain,
      source_url: url,
      name,
      title: position,
      org,
      category: "crunchbase_profile",
      meta: {
        parser: "crunchbase",
        socials: extractSocialLinks(html, url),
        snippet: text.slice(0, 400),
      },
    },
  ];
}
