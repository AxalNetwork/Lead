import type { EvaluatorFn } from "../types";

// Fires when negative-sentiment / risk-tagged news mentions appear since
// the last evaluation. Defensive against varying column names: tries a
// sentiment/risk column first, falls back to title keyword scan. Returns
// null if neither path produces a hit.
const NEG_KEYWORDS = /(lawsuit|fraud|scandal|charged|indict|sec\s*probe|investigation|fired|resign|breach|hack|leak|fine|penalt)/i;

export const evalAdverseMedia: EvaluatorFn = async (ctx) => {
  const since = ctx.oldSummary?.last_news_at ?? null;
  try {
    const rows = await ctx.env.DB.prepare(
      `SELECT nem.id AS id, na.title AS title, na.url AS url, na.published_at AS published_at,
              COALESCE(na.sentiment, '') AS sentiment
         FROM news_entity_mentions nem
         JOIN news_articles na ON na.id = nem.article_id
        WHERE nem.entity_id = ?
          ${since ? "AND datetime(na.published_at) > datetime(?)" : ""}
        ORDER BY na.published_at DESC LIMIT 20`,
    ).bind(...(since ? [ctx.entityId, since] : [ctx.entityId])).all<{
      id: string; title: string; url: string; published_at: string; sentiment: string;
    }>();
    const adverse = (rows.results ?? []).filter((r) =>
      (r.sentiment && /negative|adverse|risk/i.test(r.sentiment)) || NEG_KEYWORDS.test(r.title ?? ""));
    if (!adverse.length) return null;
    const top = adverse[0];
    return {
      dedupe_key: String(top.id ?? top.url ?? ""),
      title: `${ctx.newSummary.display_name ?? ctx.entityId}: adverse media`,
      body: adverse.slice(0, 3).map((i) => `• ${i.title} (${i.published_at})`).join("\n"),
      diff: [],
      payload: { items: adverse.slice(0, 5), since },
    };
  } catch { return null; }
};
