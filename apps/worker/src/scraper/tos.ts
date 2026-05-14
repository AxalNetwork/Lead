import flags from "../../data/tos-flags.json";

interface TosEntry {
  domain: string;
  reason: string;
}

const BLOCKED: TosEntry[] = (flags as { blocked_domains: TosEntry[] }).blocked_domains;

/**
 * Returns a ToS-block reason if direct fetching of `host` is forbidden by the
 * site's terms of service or platform agreement. The match is suffix-based
 * (covers subdomains), so `www.linkedin.com` and `m.linkedin.com` both match.
 */
export function tosBlockedReason(host: string): string | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  for (const entry of BLOCKED) {
    if (h === entry.domain || h.endsWith(`.${entry.domain}`)) {
      return `tos_blocked:${entry.domain}: ${entry.reason}`;
    }
  }
  return null;
}

export function listBlockedDomains(): TosEntry[] {
  return BLOCKED.slice();
}
