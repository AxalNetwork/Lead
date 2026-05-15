// SEC EDGAR Form D filings (private-placement / fundraising notices).
// Pulls the public "current" Atom feed; SEC requires a contact UA which
// we read from env.SEC_EDGAR_UA. Each entry is a fresh Form D filing —
// emitted as a funding_round signal against the filer.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { archiveRaw, clipSnippet } from "./_helpers";
import { compliantFetch } from "./_fetch";

const FEED = "https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type=D&output=atom&count=40";

interface AtomEntry { id: string; title: string; updated: string; link: string; summary: string }

function parseAtom(xml: string): AtomEntry[] {
  const out: AtomEntry[] = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const block = m[1];
    const id = /<id>([\s\S]*?)<\/id>/.exec(block)?.[1]?.trim() ?? "";
    const title = /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]?.trim() ?? "";
    const updated = /<updated>([\s\S]*?)<\/updated>/.exec(block)?.[1]?.trim() ?? "";
    const link = /<link[^>]*href="([^"]+)"/.exec(block)?.[1] ?? "";
    const summary = /<summary[^>]*>([\s\S]*?)<\/summary>/.exec(block)?.[1]?.trim() ?? "";
    if (id && title && updated) out.push({ id, title, updated, link, summary });
  }
  return out;
}

// SEC titles look like: "D - ACME Capital LLC (0001234567) (Filer)"
function parseFiler(title: string): { name: string; cik?: string } {
  const cik = /\((\d{6,12})\)/.exec(title)?.[1];
  const name = title.replace(/^D\s*-\s*/, "").replace(/\s*\(\d{6,12}\).*$/, "").trim();
  return { name, cik };
}

const mod: SourceModule = {
  slug: "sec_form_d",
  label: "SEC Form D (EDGAR)",
  schedule: "every6h",
  enabledByDefault: true,
  requiresEnv: "SEC_EDGAR_UA",
  docsUrl: "https://www.sec.gov/edgar/searchedgar/edgarfulltextsearch.html",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const ua = ctx.env.SEC_EDGAR_UA;
    if (!ua) return { events: [], cursor: ctx.cursor };
    const since = ctx.cursor ? Date.parse(ctx.cursor) : 0;
    let newest = since;
    const events: SignalEventDraft[] = [];
    const res = await compliantFetch(ctx.env, FEED, mod.slug, {
      accept: "application/atom+xml",
      headers: { "User-Agent": ua },
    });
    if (!res || !res.ok) return { events, cursor: ctx.cursor };
    const r2_key = await archiveRaw(ctx.env, "sec_form_d", res.body, "xml");
    for (const e of parseAtom(res.body)) {
      const ts = Date.parse(e.updated);
      if (!Number.isFinite(ts) || ts <= since) continue;
      if (ts > newest) newest = ts;
      const { name, cik } = parseFiler(e.title);
      if (!name) continue;
      events.push({
        kind: "funding_round",
        confidence: 0.7,
        payload: { source: "sec_form_d", filer: name, cik, accession: e.id },
        evidence_url: e.link || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(cik ?? "")}&type=D`,
        evidence_snippet: clipSnippet(`Form D filed by ${name}`),
        r2_key,
        occurred_at: new Date(ts).toISOString(),
        account: { name },
      });
    }
    return { events, cursor: newest > since ? new Date(newest).toISOString() : ctx.cursor };
  },
};

export default mod;
