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
      name: title?.replace(/\s*\|\s*PitchBook.*$/i, "").trim() || undefined,
      title: title ?? undefined,
      category: "pitchbook_profile",
      meta: { parser: "pitchbook", snippet: stripTags(html).slice(0, 400) },
    },
  ];
}
