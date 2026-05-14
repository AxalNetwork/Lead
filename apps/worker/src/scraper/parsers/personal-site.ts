import type { ParsedLead } from "../../types";
import { extractDomain, normalizeEmail } from "../normalize";
import { extractEmails, extractSocialLinks, extractTitle } from "../html";

export function parse(html: string, url: string): ParsedLead[] {
  const source_domain = extractDomain(url);
  const title = extractTitle(html);
  const emails = extractEmails(html).map(normalizeEmail).filter((e): e is string => Boolean(e));
  const socials = extractSocialLinks(html, url);

  if (emails.length === 0) {
    return [
      {
        source_domain,
        source_url: url,
        name: title ?? undefined,
        meta: { parser: "personal-site", socials },
      },
    ];
  }
  return emails.map((email) => ({
    source_domain,
    source_url: url,
    name: title ?? undefined,
    email,
    meta: { parser: "personal-site", socials },
  }));
}
