import type { EvaluatorFn } from "../types";

// Looks at the news_entity_mentions table directly to find articles
// published after the previous evaluation timestamp. Dedupe key is the
// news mention id (or url hash) so each article fires at most once.
export const evalNewNewsItem: EvaluatorFn = async (ctx) => {
  // Prefer the per-entity watermark (source-driven cutoff). Fall back to
  // last_news_at from the summary only when no watermark exists yet
  // (e.g. first post-baseline tick). News rows can be inserted without
  // the summary's last_news_at moving (out-of-order publish, backfill),
  // so the watermark is the authoritative anchor.
  const since = ctx.sinceWatermark ?? ctx.oldSummary?.last_news_at ?? null;
  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT nem.id AS id, nem.entity_id, na.title AS title, na.url AS url, na.published_at AS published_at
         FROM news_entity_mentions nem
         JOIN news_items na ON na.id = nem.news_item_id
        WHERE nem.entity_id = ?
          ${since ? "AND datetime(na.published_at) > datetime(?)" : ""}
        ORDER BY na.published_at DESC LIMIT 5`,
    ).bind(...(since ? [ctx.entityId, since] : [ctx.entityId])).all<{
      id: string; entity_id: string; title: string; url: string; published_at: string;
    }>();
    const items = rows.results ?? [];
    if (!items.length) return null;
    const top = items[0];
    return {
      dedupe_key: String(top.id ?? top.url ?? ""),
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: ${items.length} new news item${items.length > 1 ? "s" : ""}`,
      body: items.slice(0, 3).map((i) => `• ${i.title} (${i.published_at})`).join("\n"),
      diff: [],
      payload: { items, since },
    };
  } catch {
    return null; // table missing
  }
};
