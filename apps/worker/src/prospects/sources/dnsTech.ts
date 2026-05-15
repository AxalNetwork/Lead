// DNS / MX-record based tech detection. Free; queries Cloudflare's
// 1.1.1.1 DNS-over-HTTPS resolver. Per top-priority account we resolve
// MX (email vendor) and root NS (hosting vendor) records, map them to a
// canonical vendor via the inference table below, then write an
// account_tech row + emit a tech_install signal per newly detected
// vendor.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

interface AccountRow { id: string; domain: string | null; name: string }
interface DohAnswer { name?: string; type?: number; data?: string }
interface DohResp { Answer?: DohAnswer[] }

interface VendorMatch { vendor: string; category: string }
const MX_VENDORS: Array<{ pat: RegExp; vendor: string; category: string }> = [
  { pat: /\.google(?:mail)?\.com\.?$/i, vendor: "Google Workspace", category: "email" },
  { pat: /aspmx\.l\.google\.com\.?$/i, vendor: "Google Workspace", category: "email" },
  { pat: /\.protection\.outlook\.com\.?$/i, vendor: "Microsoft 365", category: "email" },
  { pat: /\.mail\.protection\.outlook\.com\.?$/i, vendor: "Microsoft 365", category: "email" },
  { pat: /\.mailgun\.org\.?$/i, vendor: "Mailgun", category: "email" },
  { pat: /\.sendgrid\.net\.?$/i, vendor: "SendGrid", category: "email" },
  { pat: /\.zoho(?:mail)?\.com\.?$/i, vendor: "Zoho Mail", category: "email" },
  { pat: /\.fastmail\.com\.?$/i, vendor: "Fastmail", category: "email" },
  { pat: /\.protonmail\.ch\.?$/i, vendor: "Proton Mail", category: "email" },
  { pat: /\.mimecast\.com\.?$/i, vendor: "Mimecast", category: "email_security" },
  { pat: /\.pphosted\.com\.?$/i, vendor: "Proofpoint", category: "email_security" },
  { pat: /\.messagelabs\.com\.?$/i, vendor: "Symantec MessageLabs", category: "email_security" },
];
const NS_VENDORS: Array<{ pat: RegExp; vendor: string; category: string }> = [
  { pat: /\.cloudflare\.com\.?$/i, vendor: "Cloudflare", category: "dns_cdn" },
  { pat: /\.awsdns-/i, vendor: "Amazon Route 53", category: "dns_cdn" },
  { pat: /\.googledomains\.com\.?$/i, vendor: "Google Domains", category: "dns_cdn" },
  { pat: /\.dnsimple\.com\.?$/i, vendor: "DNSimple", category: "dns_cdn" },
  { pat: /\.vercel-dns\.com\.?$/i, vendor: "Vercel", category: "hosting" },
  { pat: /\.netlify\.com\.?$/i, vendor: "Netlify", category: "hosting" },
  { pat: /\.azure-dns\.com\.?$/i, vendor: "Azure DNS", category: "dns_cdn" },
  { pat: /\.dnsmadeeasy\.com\.?$/i, vendor: "DNS Made Easy", category: "dns_cdn" },
  { pat: /\.nsone\.net\.?$/i, vendor: "NS1", category: "dns_cdn" },
];

function matchVendors(targets: string[], table: typeof MX_VENDORS): VendorMatch[] {
  const out = new Map<string, VendorMatch>();
  for (const t of targets) {
    for (const row of table) {
      if (row.pat.test(t)) out.set(row.vendor, { vendor: row.vendor, category: row.category });
    }
  }
  return [...out.values()];
}

async function resolve(env: SourceContext["env"], name: string, type: "MX" | "NS"): Promise<string[]> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=${type}`;
  const res = await compliantFetch(env, url, "dns_tech", { accept: "application/dns-json" });
  if (!res || !res.ok) return [];
  try {
    const j = JSON.parse(res.body) as DohResp;
    return (j.Answer ?? []).map((a) => (a.data ?? "").trim()).filter(Boolean);
  } catch { return []; }
}

const mod: SourceModule = {
  slug: "dns_tech",
  label: "DNS Tech Detection",
  schedule: "daily",
  enabledByDefault: true,
  docsUrl: "https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, name FROM accounts WHERE id = ? AND domain IS NOT NULL`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, name FROM accounts
            WHERE domain IS NOT NULL AND status NOT IN ('lost','disqualified')
            ORDER BY account_score DESC LIMIT 50`,
        ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      if (!r.domain) continue;
      const mx = await resolve(ctx.env, r.domain, "MX");
      const ns = await resolve(ctx.env, r.domain, "NS");
      // MX records arrive as "10 aspmx.l.google.com." — strip the priority.
      const mxHosts = mx.map((s) => s.replace(/^\d+\s+/, ""));
      const matches = [...matchVendors(mxHosts, MX_VENDORS), ...matchVendors(ns, NS_VENDORS)];
      if (!matches.length) continue;
      const archive = JSON.stringify({ domain: r.domain, mx, ns, matches });
      const r2_key = await archiveRaw(ctx.env, "dns_tech", archive, "json");
      const now = new Date().toISOString();
      for (const m of matches) {
        // Skip emit when this vendor was already recorded for this account
        // by dns_tech — UNIQUE(account_id,vendor,source) makes the insert
        // idempotent, but we want to avoid a duplicate signal each day.
        const existing = await ctx.env.DB.prepare(
          `SELECT id FROM account_tech WHERE account_id = ? AND vendor = ? AND source = 'dns_tech' LIMIT 1`,
        ).bind(r.id, m.vendor).first<{ id: number }>();
        try {
          await ctx.env.DB.prepare(
            `INSERT INTO account_tech (account_id, vendor, category, confidence, first_detected_at, last_detected_at, source, evidence_url)
             VALUES (?, ?, ?, ?, ?, ?, 'dns_tech', ?)
             ON CONFLICT(account_id, vendor, source) DO UPDATE SET
               last_detected_at = excluded.last_detected_at,
               confidence = excluded.confidence`,
          ).bind(r.id, m.vendor, m.category, 0.85, existing ? null : now, now, `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(r.domain)}`).run();
        } catch (e) { console.warn("dns_tech account_tech write failed", r.id, m.vendor, (e as Error).message); }
        if (existing) continue;
        events.push({
          kind: "tech_install",
          confidence: 0.7,
          payload: { vendor: m.vendor, category: m.category, source: "dns_tech", account_id: r.id, mx, ns },
          evidence_url: `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(r.domain)}`,
          evidence_snippet: clipSnippet(`${m.vendor} (${m.category}) detected for ${r.domain} via DNS`),
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
