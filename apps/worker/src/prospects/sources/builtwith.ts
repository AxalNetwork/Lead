// BuiltWith API — paid; requires env.BUILTWITH_API_KEY. Skipped at the
// runner level when key is absent. When configured, hits the v21 lookup
// endpoint per high-priority account, persists detected vendors into
// account_tech, and emits a tech_install signal per new vendor.

import type { SourceModule, SignalEventDraft, CrawlResult, SourceContext } from "./_types";
import { compliantFetch } from "./_fetch";
import { archiveRaw, clipSnippet } from "./_helpers";

interface AccountRow { id: string; domain: string | null; name: string }
interface BuiltWithTech { Name: string; Tag?: string; FirstDetected?: number; LastDetected?: number; IsPremium?: string }
interface BuiltWithPath { Technologies?: BuiltWithTech[] }
interface BuiltWithDomainResult { Result?: { Paths?: BuiltWithPath[] } }
interface BuiltWithResp { Results?: BuiltWithDomainResult[] }

const mod: SourceModule = {
  slug: "builtwith",
  label: "BuiltWith Tech Stack",
  schedule: "daily",
  enabledByDefault: false,
  requiresEnv: "BUILTWITH_API_KEY",
  docsUrl: "https://api.builtwith.com/",
  async crawl(ctx: SourceContext): Promise<CrawlResult> {
    const events: SignalEventDraft[] = [];
    const key = (ctx.env as unknown as Record<string, string | undefined>).BUILTWITH_API_KEY;
    if (!key) return { events, cursor: ctx.cursor };

    const rows = ctx.accountId
      ? await ctx.env.DB.prepare(`SELECT id, domain, name FROM accounts WHERE id = ? AND domain IS NOT NULL`).bind(ctx.accountId).all<AccountRow>()
      : await ctx.env.DB.prepare(
          `SELECT id, domain, name FROM accounts
            WHERE domain IS NOT NULL AND status NOT IN ('lost','disqualified')
            ORDER BY account_score DESC LIMIT 20`,
        ).all<AccountRow>();

    for (const r of rows.results ?? []) {
      const url = `https://api.builtwith.com/v21/api.json?KEY=${encodeURIComponent(key)}&LOOKUP=${encodeURIComponent(r.domain ?? "")}`;
      const fetched = await compliantFetch(ctx.env, url, mod.slug, { accept: "application/json" });
      if (!fetched || !fetched.ok) continue;
      const r2_key = await archiveRaw(ctx.env, "builtwith", fetched.body, "json");
      let parsed: BuiltWithResp;
      try { parsed = JSON.parse(fetched.body) as BuiltWithResp; } catch { continue; }
      const techs: BuiltWithTech[] = [];
      for (const result of parsed.Results ?? []) {
        for (const path of result.Result?.Paths ?? []) {
          for (const t of path.Technologies ?? []) techs.push(t);
        }
      }

      // Persist into account_tech (UNIQUE(account_id, vendor, source) dedupes).
      for (const t of techs) {
        const vendor = t.Name?.trim();
        if (!vendor) continue;
        const first = t.FirstDetected ? new Date(t.FirstDetected).toISOString() : null;
        const last = t.LastDetected ? new Date(t.LastDetected).toISOString() : null;
        try {
          await ctx.env.DB.prepare(
            `INSERT INTO account_tech (account_id, vendor, category, confidence, first_detected_at, last_detected_at, source, evidence_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(account_id, vendor, source) DO UPDATE SET
               last_detected_at = excluded.last_detected_at,
               confidence = excluded.confidence`,
          ).bind(r.id, vendor, t.Tag ?? null, 0.9, first, last, "builtwith", `https://builtwith.com/?${encodeURIComponent(r.domain ?? "")}`).run();
        } catch (e) { console.warn("builtwith account_tech write failed", r.id, vendor, (e as Error).message); }

        events.push({
          kind: "tech_install",
          confidence: 0.85,
          payload: { vendor, category: t.Tag, premium: t.IsPremium, account_id: r.id },
          evidence_url: `https://builtwith.com/?${encodeURIComponent(r.domain ?? "")}#${encodeURIComponent(vendor)}`,
          evidence_snippet: clipSnippet(`${vendor}${t.Tag ? ` (${t.Tag})` : ""} detected on ${r.domain}`),
          r2_key,
          occurred_at: last ?? undefined,
          account: { domain: r.domain ?? undefined, name: r.name },
        });
      }
    }
    return { events, cursor: ctx.cursor };
  },
};

export default mod;
