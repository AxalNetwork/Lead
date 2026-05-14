import type { ParsedLead } from "../../types";
import { extractDomain } from "../normalize";
import { extractAnchors, extractEmails, extractTitle, extractSocialLinks } from "../html";

/**
 * Linktree pages list a creator's outbound links. We promote each external
 * link as a discovery target while attaching the creator's display name.
 */
export function parse(html: string, url: string): ParsedLead[] {
  const source_domain = extractDomain(url);
  const title = extractTitle(html);
  const name = title?.replace(/\s*\|\s*Linktree.*$/i, "").trim() || undefined;
  const anchors = extractAnchors(html, url).filter((a) => /^https?:\/\//i.test(a.href));
  const socials = extractSocialLinks(html, url);
  const emails = extractEmails(html);

  const leads: ParsedLead[] = [
    {
      source_domain,
      source_url: url,
      name,
      title: title ?? undefined,
      meta: { parser: "linktree", outbound: anchors.map((a) => a.href), socials, emails },
    },
  ];
  return leads;
}
