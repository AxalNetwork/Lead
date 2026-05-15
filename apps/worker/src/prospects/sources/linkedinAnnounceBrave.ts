// LinkedIn Announcements — same Brave-snippet-only constraint.
// Surfaces leadership_change / partnership_announce / product_launch
// signals from snippets of `site:linkedin.com/posts` (and /pulse) hits.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import type { SignalKind } from "../signalKinds";
import { archiveRaw, braveSearch, clipSnippet } from "./_helpers";

interface AccountRow { id: string; domain: string | null; name: string }

function classify(text: string): SignalKind | null {
  const t = text.toLowerCase();
  if (/\b(promoted|joined|appointed|hires?|new (ceo|cto|cfo|cmo|coo|vp|head of)|named .* (ceo|cto|cfo|cmo|coo))\b/.test(t)) return "leadership_change";
  if (/\b(partner(ed|ship)?|integration|teaming up|joins forces|collaborat)/.test(t)) return "partnership_announce";
  if (/\b(launch(ed|ing)?|introducing|announce[ds]?|releas(ed|ing)?|now available|debuts?)\b/.test(t)) return "product_launch";
  return null;
}

const mod: SourceModule = {
  slug: "linkedin_announce_brave",
  label: "LinkedIn Announcements (Brave cache)",
  schedule: "every6h",
  enabledByDefault: true,
  bravePoweredOnly: true,
  requiresEnv: "BRAVE_API_KEY",
  docsUrl: "https://api.search.brave.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const since = ctx.cursor ? Date.parse(ctx.cursor) : Date.now() - 7 * 86400 * 1000;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, name FROM accounts WHERE id = ?`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, name FROM accounts
            WHERE status NOT IN ('lost','disqualified') AND name IS NOT NULL
            ORDER BY account_score DESC LIMIT 25`,
        ).all<AccountRow>();
    for (const r of rows.results ?? []) {
      if (!r.name) continue;
      const q = `(site:linkedin.com/posts OR site:linkedin.com/pulse) "${r.name}" (announces OR launches OR partners OR joins OR promoted)`;
      const hits = await braveSearch(ctx.env, q, 15);
      if (!hits.length) continue;
      await archiveRaw(ctx.env, "linkedin_announce_brave", JSON.stringify({ q, hits }), "json");
      for (const h of hits) {
        if (!/linkedin\.com\/(posts|pulse)\//i.test(h.url)) continue;
        // Drop undated hits — see comment in linkedinJobsBrave.ts.
        if (!h.pageAge) continue;
        const ts = Date.parse(h.pageAge);
        if (!Number.isFinite(ts) || ts <= since) continue;
        const kind = classify(`${h.title} ${h.description}`);
        if (!kind) continue;
        if (ts > newest) newest = ts;
        events.push({
          kind,
          confidence: 0.45,
          payload: { source: "linkedin_brave", query: r.name, title: h.title, description: h.description },
          evidence_url: h.url,
          evidence_snippet: clipSnippet(`${h.title} — ${h.description}`),
          occurred_at: new Date(ts).toISOString(),
          account: { domain: r.domain ?? undefined, name: r.name },
        });
      }
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
