// DNS / MX-record based tech detection. Free; queries Cloudflare's
// 1.1.1.1 DNS-over-HTTPS resolver. Skeleton — full impl iterates accounts
// with a domain, fetches MX/CNAME records, infers vendor (Google/Microsoft
// for email, Vercel/Netlify/Cloudflare for hosting), then emits
// tech_install signals via account_tech rows. Disabled by default until
// the vendor inference table lands.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";

const mod: SourceModule = {
  slug: "dns_tech",
  label: "DNS Tech Detection",
  schedule: "daily",
  enabledByDefault: false,
  docsUrl: "https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/",
  async crawl(_ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    return { events, cursor: null };
  },
};

export default mod;
