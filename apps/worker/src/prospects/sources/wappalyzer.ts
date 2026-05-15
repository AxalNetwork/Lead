// Wappalyzer-style detection — runs a tiny built-in ruleset against the
// homepage HTML of high-priority accounts. Cheap and ToS-safe (homepage
// only, one fetch per account, robots-respecting via compliantFetch).
// Each newly detected vendor writes an account_tech row + emits a
// tech_install signal.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface AccountRow { id: string; domain: string | null; name: string }

const RULES: Array<{ vendor: string; category: string; pat: RegExp }> = [
  { vendor: "HubSpot", category: "marketing_automation", pat: /js\.hs(?:-scripts|forms|adspixel)\.(?:com|net)/i },
  { vendor: "Marketo", category: "marketing_automation", pat: /(?:munchkin|mktoresp|marketo)\.com/i },
  { vendor: "Pardot", category: "marketing_automation", pat: /pardot\.com|pi\.pardot\.com/i },
  { vendor: "Segment", category: "analytics", pat: /cdn\.segment\.com|analytics\.js/i },
  { vendor: "Google Analytics", category: "analytics", pat: /(?:googletagmanager\.com\/gtag|google-analytics\.com|gtag\(|UA-\d{4,}|G-[A-Z0-9]{6,})/i },
  { vendor: "Google Tag Manager", category: "analytics", pat: /googletagmanager\.com\/gtm\.js/i },
  { vendor: "Mixpanel", category: "analytics", pat: /cdn\.mxpnl\.com|mixpanel\.com\/track/i },
  { vendor: "Amplitude", category: "analytics", pat: /amplitude\.com\/libs\/amplitude/i },
  { vendor: "Hotjar", category: "analytics", pat: /static\.hotjar\.com|hj\.q=/i },
  { vendor: "Intercom", category: "support", pat: /widget\.intercom\.io|intercomcdn\.com/i },
  { vendor: "Zendesk", category: "support", pat: /zdassets\.com|zendesk\.com\/embeddable/i },
  { vendor: "Drift", category: "support", pat: /js\.driftt\.com|drift\.com\/embed/i },
  { vendor: "Stripe", category: "payments", pat: /js\.stripe\.com\/v\d/i },
  { vendor: "PayPal", category: "payments", pat: /paypal\.com\/sdk|paypalobjects\.com/i },
  { vendor: "Shopify", category: "ecommerce", pat: /cdn\.shopify\.com|Shopify\.shop/i },
  { vendor: "WordPress", category: "cms", pat: /wp-(?:content|includes)\//i },
  { vendor: "Webflow", category: "cms", pat: /assets\.website-files\.com|webflow\.js/i },
  { vendor: "Wix", category: "cms", pat: /static\.parastorage\.com|wix\.com\b/i },
  { vendor: "Squarespace", category: "cms", pat: /static\d?\.squarespace\.com/i },
  { vendor: "Cloudflare", category: "cdn", pat: /cdnjs\.cloudflare\.com|cf-(?:cgi|ray)|__cf(?:duid|email)/i },
  { vendor: "Vercel", category: "hosting", pat: /_next\/static|vercel\.app/i },
  { vendor: "Netlify", category: "hosting", pat: /netlify\.app|netlifyusercontent\.com/i },
  { vendor: "Salesforce", category: "crm", pat: /salesforceliveagent|force\.com|salesforce\.com\/services/i },
  { vendor: "Optimizely", category: "ab_testing", pat: /cdn\.optimizely\.com/i },
];

const META_GEN = /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i;

function detect(html: string): Array<{ vendor: string; category: string }> {
  const out = new Map<string, { vendor: string; category: string }>();
  for (const r of RULES) {
    if (r.pat.test(html)) out.set(r.vendor, { vendor: r.vendor, category: r.category });
  }
  const gen = META_GEN.exec(html)?.[1];
  if (gen) {
    const lower = gen.toLowerCase();
    if (lower.includes("wordpress")) out.set("WordPress", { vendor: "WordPress", category: "cms" });
    else if (lower.includes("ghost")) out.set("Ghost", { vendor: "Ghost", category: "cms" });
    else if (lower.includes("hugo")) out.set("Hugo", { vendor: "Hugo", category: "cms" });
    else if (lower.includes("jekyll")) out.set("Jekyll", { vendor: "Jekyll", category: "cms" });
    else if (lower.includes("drupal")) out.set("Drupal", { vendor: "Drupal", category: "cms" });
  }
  return [...out.values()];
}

const mod: SourceModule = {
  slug: "wappalyzer",
  label: "Wappalyzer-style Detection",
  schedule: "daily",
  enabledByDefault: true,
  docsUrl: "https://www.wappalyzer.com/api/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, name FROM accounts WHERE id = ? AND domain IS NOT NULL`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, name FROM accounts
            WHERE domain IS NOT NULL AND status NOT IN ('lost','disqualified')
            ORDER BY account_score DESC LIMIT 25`,
        ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      if (!r.domain) continue;
      const url = `https://${r.domain}/`;
      const res = await compliantFetch(ctx.env, url, mod.slug, { accept: "text/html" });
      if (!res || !res.ok || !res.body) continue;
      const r2_key = await archiveRaw(ctx.env, "wappalyzer", res.body, "html");
      const matches = detect(res.body);
      if (!matches.length) continue;
      const now = new Date().toISOString();
      for (const m of matches) {
        const existing = await ctx.env.DB.prepare(
          `SELECT id FROM account_tech WHERE account_id = ? AND vendor = ? AND source = 'wappalyzer' LIMIT 1`,
        ).bind(r.id, m.vendor).first<{ id: number }>();
        try {
          await ctx.env.DB.prepare(
            `INSERT INTO account_tech (account_id, vendor, category, confidence, first_detected_at, last_detected_at, source, evidence_url)
             VALUES (?, ?, ?, ?, ?, ?, 'wappalyzer', ?)
             ON CONFLICT(account_id, vendor, source) DO UPDATE SET
               last_detected_at = excluded.last_detected_at,
               confidence = excluded.confidence`,
          ).bind(r.id, m.vendor, m.category, 0.8, existing ? null : now, now, url).run();
        } catch (e) { console.warn("wappalyzer account_tech write failed", r.id, m.vendor, (e as Error).message); }
        if (existing) continue;
        events.push({
          kind: "tech_install",
          confidence: 0.75,
          payload: { vendor: m.vendor, category: m.category, source: "wappalyzer", account_id: r.id },
          evidence_url: url,
          evidence_snippet: clipSnippet(`${m.vendor} (${m.category}) detected on ${r.domain}`),
          r2_key,
          occurred_at: now,
          account: { domain: r.domain, name: r.name },
        });
      }
    }
    return { events, cursor: ctx.cursor };
  },
};

export default mod;
