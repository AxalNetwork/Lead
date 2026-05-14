import type { ParsedLead } from "../../types";
import { extractDomain } from "../normalize";
import { extractAnchors, extractEmails, extractTitle, extractSocialLinks } from "../html";

export function parse(html: string, url: string): ParsedLead[] {
  const source_domain = extractDomain(url);
  const title = extractTitle(html);
  const anchors = extractAnchors(html, url).filter((a) => /^https?:\/\//i.test(a.href));
  return [
    {
      source_domain,
      source_url: url,
      name: title?.replace(/\s*[-|·]\s*Beacons.*$/i, "").trim() || undefined,
      title: title ?? undefined,
      meta: {
        parser: "beacons",
        outbound: anchors.map((a) => a.href),
        socials: extractSocialLinks(html, url),
        emails: extractEmails(html),
      },
    },
  ];
}
