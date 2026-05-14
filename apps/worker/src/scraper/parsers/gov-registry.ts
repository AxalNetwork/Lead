import type { ParsedLead } from "../../types";
import { extractDomain } from "../normalize";
import { extractTitle, stripTags } from "../html";

export function parse(html: string, url: string): ParsedLead[] {
  const source_domain = extractDomain(url);
  const title = extractTitle(html);
  return [
    {
      source_domain,
      source_url: url,
      name: title ?? undefined,
      category: "gov_registry",
      meta: { parser: "gov-registry", snippet: stripTags(html).slice(0, 600) },
    },
  ];
}
