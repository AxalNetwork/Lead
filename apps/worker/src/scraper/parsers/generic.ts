import type { ParsedLead } from "../../types";
import { extractDomain, normalizeEmail } from "../normalize";
import { extractEmails, extractSocialLinks, extractTitle } from "../html";

/**
 * Generic parser: emits one lead per email found, plus a single page-level lead
 * if no emails are present. Always populates source_domain + source_url so the
 * minimal "row exists per fetch" acceptance is met.
 */
export function parse(html: string, url: string): ParsedLead[] {
  const source_domain = extractDomain(url);
  const source_url = url;
  const title = extractTitle(html);
  const emails = extractEmails(html).map(normalizeEmail).filter((e): e is string => Boolean(e));
  const socials = extractSocialLinks(html, url);

  if (emails.length === 0) {
    return [
      {
        source_domain,
        source_url,
        title: title ?? undefined,
        meta: { socials, parser: "generic" },
      },
    ];
  }

  return emails.map((email) => ({
    source_domain,
    source_url,
    email,
    title: title ?? undefined,
    meta: { socials, parser: "generic" },
  }));
}
