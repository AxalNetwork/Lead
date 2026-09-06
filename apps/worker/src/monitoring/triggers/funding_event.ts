import type { EvaluatorFn } from "../types";

// For an org entity, fires when a fresh `investor_investments` row lists
// this entity as the company side, OR when news mentions include a funding
// keyword. Either path produces a single event per round.
const FUND_KW = /(raise[ds]?|round|series\s*[a-f]|seed|funding|capital)/i;

export const evalFundingEvent: EvaluatorFn = async (ctx) => {
  const since = ctx.sinceWatermark ?? ctx.oldSummary?.last_news_at ?? null;
  // (1) investor_investments where this entity is the company.
  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT id, investor_entity_id, investor_name, round, amount_usd, announced_at
         FROM investor_investments
        WHERE company_entity_id = ?
          ${since ? "AND datetime(announced_at) > datetime(?)" : ""}
        ORDER BY announced_at DESC LIMIT 5`,
    ).bind(...(since ? [ctx.entityId, since] : [ctx.entityId])).all<{
      id: string | number; investor_entity_id: string | null; investor_name: string | null;
      round: string | null; amount_usd: number | null; announced_at: string | null;
    }>();
    const items = rows.results ?? [];
    if (items.length) {
      const top = items[0];
      return {
        dedupe_key: String(top.id ?? `${top.round ?? ""}|${top.announced_at ?? ""}`),
        title: `${ctx.newSummary.display_name ?? ctx.entityId}: funding event — ${top.round ?? "round"}`,
        body: items.slice(0, 3).map((i) =>
          `• ${i.investor_name ?? i.investor_entity_id ?? "?"} — ${i.round ?? "?"}${i.amount_usd ? ` $${i.amount_usd}` : ""} (${i.announced_at ?? "?"})`).join("\n"),
        diff: [],
        payload: { items, since },
      };
    }
  } catch { /* table missing — fall through to news */ }
  // (2) news keyword fallback.
  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT na.id AS id, na.title AS title, na.url AS url, na.published_at AS published_at
         FROM news_entity_mentions nem JOIN news_items na ON na.id = nem.news_item_id
        WHERE nem.entity_id = ?
          ${since ? "AND datetime(na.published_at) > datetime(?)" : ""}
        ORDER BY na.published_at DESC LIMIT 20`,
    ).bind(...(since ? [ctx.entityId, since] : [ctx.entityId])).all<{
      id: string; title: string; url: string; published_at: string;
    }>();
    const hits = (rows.results ?? []).filter((r) => FUND_KW.test(r.title ?? ""));
    if (!hits.length) return null;
    const top = hits[0];
    return {
      dedupe_key: String(top.id ?? top.url ?? ""),
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: possible funding mention`,
      body: hits.slice(0, 3).map((i) => `• ${i.title} (${i.published_at})`).join("\n"),
      diff: [],
      payload: { items: hits.slice(0, 5), since },
    };
  } catch { return null; }
};
