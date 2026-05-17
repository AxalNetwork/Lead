import type { EvaluatorFn } from "../types";

// Generic per-platform "new post" evaluator. Concrete kinds bind a
// specific platform value. All three are defensive: the identity_posts
// table is optional.
export function makeSocialPostEvaluator(platform: string, kindLabel: string): EvaluatorFn {
  return async (ctx) => {
    const since = ctx.sinceWatermark
      ?? ((ctx.oldSummary as Record<string, unknown> | null)?.["last_post_at"] as string | null)
      ?? null;
    try {
      const rows = await ctx.env.DB.prepare(
        `SELECT id, platform, posted_at, url, snippet
           FROM identity_posts
          WHERE entity_id = ? AND platform = ?
            ${since ? "AND datetime(posted_at) > datetime(?)" : ""}
          ORDER BY posted_at DESC LIMIT 5`,
      ).bind(...(since ? [ctx.entityId, platform, since] : [ctx.entityId, platform])).all<{
        id: string; platform: string; posted_at: string; url: string; snippet: string;
      }>();
      const items = rows.results ?? [];
      if (!items.length) return null;
      const top = items[0];
      return {
        dedupe_key: String(top.id ?? top.url ?? top.posted_at ?? ""),
        title: `${ctx.newSummary.display_name ?? ctx.entityId}: ${items.length} new ${kindLabel}${items.length > 1 ? "s" : ""}`,
        body: items.slice(0, 3).map((i) => `• ${(i.snippet ?? "").slice(0, 140)} (${i.posted_at})`).join("\n"),
        diff: [],
        payload: { items, since },
      };
    } catch { return null; }
  };
}

export const evalNewTweet   = makeSocialPostEvaluator("twitter", "tweet");
export const evalNewPodcast = makeSocialPostEvaluator("podcast", "podcast episode");
export const evalNewPost    = makeSocialPostEvaluator("blog",    "post");
