// Task #2: News + facts-citations API.
//
//   GET  /api/news/entity/:id?limit=&topic=&min_rep=&sentiment=&from=&to=
//   GET  /api/news/item/:id
//   GET  /api/news/coverage
//   POST /api/news/refresh/:entityId         { wiki?, archive?, max? }
//   POST /api/news/refresh/:entityId/dispatch (durable workflow)
//   GET  /api/facts/:id/citations
//   POST /api/facts/:id/cite                 { news_item_id, quote?, contradicts? }
//   POST /api/facts/:id/resolve-dispute      { competing_fact_id?, decision, notes? }

import { Hono } from "hono";
import type { Env } from "../types";
import { refreshEntityNews } from "../news/refresh";
import { recomputeVerifiedScore } from "../news/citations";
import { ensureSeeded } from "../news/reputability";

export const newsRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();
export const factsCitationsRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

// ----------------- /api/news/entity/:id -----------------

newsRoute.get("/entity/:id", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
  const minRep = Number(c.req.query("min_rep") ?? "0");
  const topic = c.req.query("topic")?.toLowerCase() ?? null;
  const sentiment = c.req.query("sentiment") ?? null; // 'pos' | 'neg' | 'neutral'
  // ISO date strings (YYYY-MM-DD or full ISO timestamp). Both inclusive.
  const from = c.req.query("from") ?? null;
  const to = c.req.query("to") ?? null;

  let sentFilter = "";
  if (sentiment === "pos") sentFilter = "AND (nem.sentiment_about_entity > 0.2 OR ni.sentiment > 0.2)";
  else if (sentiment === "neg") sentFilter = "AND (nem.sentiment_about_entity < -0.2 OR ni.sentiment < -0.2)";
  else if (sentiment === "neutral") sentFilter = "AND COALESCE(nem.sentiment_about_entity, ni.sentiment, 0) BETWEEN -0.2 AND 0.2";

  const topicClause = topic ? "AND (lower(ni.title) LIKE ? OR lower(ni.summary) LIKE ?)" : "";
  // Date filter is applied against COALESCE(published_at, fetched_at) so
  // articles missing a publication date still respect the operator window.
  const fromClause = from ? "AND COALESCE(ni.published_at, ni.fetched_at) >= ?" : "";
  const toClause = to ? "AND COALESCE(ni.published_at, ni.fetched_at) <= ?" : "";
  const baseBind: unknown[] = [id, minRep];
  if (topic) baseBind.push(`%${topic}%`, `%${topic}%`);
  if (from) baseBind.push(from);
  if (to) baseBind.push(to);

  const rows = await c.env.DB.prepare(
    `SELECT ni.id, ni.url, ni.host, ni.title, ni.headline, ni.byline, ni.published_at,
            ni.source_name, ni.source_reputability, ni.language, ni.summary, ni.body_excerpt,
            ni.archive_url, ni.sentiment, ni.topics_json, ni.fetched_at,
            nem.mention_count, nem.context_quote, nem.is_subject, nem.sentiment_about_entity, nem.confidence
       FROM news_entity_mentions nem
       JOIN news_items ni ON ni.id = nem.news_item_id
      WHERE nem.entity_id = ?
        AND ni.source_reputability >= ?
        ${topicClause}
        ${fromClause}
        ${toClause}
        ${sentFilter}
      ORDER BY COALESCE(ni.published_at, ni.fetched_at) DESC
      LIMIT ? OFFSET ?`,
  ).bind(...baseBind, limit, offset).all();

  const totalRow = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM news_entity_mentions nem
       JOIN news_items ni ON ni.id = nem.news_item_id
      WHERE nem.entity_id = ?
        AND ni.source_reputability >= ?
        ${topicClause}
        ${fromClause}
        ${toClause}
        ${sentFilter}`,
  ).bind(...baseBind).first<{ n: number }>();
  const total = totalRow?.n ?? 0;
  const next_offset = offset + limit < total ? offset + limit : null;
  return c.json({ items: rows.results ?? [], meta: { total, limit, offset, next_offset } });
});

// ----------------- /api/news/item/:id -----------------

newsRoute.get("/item/:id", async (c) => {
  const id = c.req.param("id");
  const item = await c.env.DB.prepare(`SELECT * FROM news_items WHERE id = ?`).bind(id).first();
  if (!item) return c.json({ error: "not_found" }, 404);
  const mentions = await c.env.DB.prepare(
    `SELECT nem.entity_id, nem.mention_count, nem.context_quote, nem.is_subject, nem.sentiment_about_entity, nem.confidence,
            u.display_name, u.kind
       FROM news_entity_mentions nem
       LEFT JOIN u_entities u ON u.id = nem.entity_id
      WHERE nem.news_item_id = ?
      ORDER BY nem.is_subject DESC, nem.confidence DESC`,
  ).bind(id).all();
  return c.json({ item, mentions: mentions.results ?? [] });
});

// ----------------- /api/news/coverage -----------------

newsRoute.get("/coverage", async (c) => {
  const noCitations = await c.env.DB.prepare(
    `SELECT u.id, u.display_name, u.kind, u.quality_score
       FROM u_entities u
      WHERE u.status='active'
        AND NOT EXISTS (
          SELECT 1 FROM facts f
           JOIN fact_citations fc ON fc.fact_id = f.id
          WHERE f.entity_id = u.id
        )
      ORDER BY u.quality_score DESC
      LIMIT 100`,
  ).all();
  const onlyBlogs = await c.env.DB.prepare(
    `SELECT u.id, u.display_name, u.kind, COUNT(DISTINCT ni.host) AS hosts, AVG(ni.source_reputability) AS avg_rep
       FROM u_entities u
       JOIN facts f ON f.entity_id = u.id
       JOIN fact_citations fc ON fc.fact_id = f.id
       JOIN news_items ni ON ni.id = fc.news_item_id
      WHERE u.status='active'
      GROUP BY u.id
      HAVING AVG(ni.source_reputability) < 0.5
      ORDER BY avg_rep ASC
      LIMIT 100`,
  ).all();
  const contradicting = await c.env.DB.prepare(
    `SELECT f.id AS fact_id, f.entity_id, f.predicate, f.value_text, f.value_number, f.verified_score,
            COUNT(*) AS contradicting_citations
       FROM facts f
       JOIN fact_citations fc ON fc.fact_id = f.id
      WHERE fc.contradicts = 1
      GROUP BY f.id
      ORDER BY contradicting_citations DESC
      LIMIT 100`,
  ).all();
  return c.json({
    entities_without_citations: noCitations.results ?? [],
    entities_only_blog_citations: onlyBlogs.results ?? [],
    contradicting_facts: contradicting.results ?? [],
  });
});

// ----------------- /api/news/refresh/:entityId -----------------

newsRoute.post("/refresh/:entityId", async (c) => {
  const entityId = c.req.param("entityId");
  const body = (await c.req.json().catch(() => ({}))) as { wiki?: boolean; archive?: boolean; max?: number };
  await ensureSeeded(c.env);
  const r = await refreshEntityNews(c.env, entityId, { wiki: body.wiki, archive: body.archive, maxArticles: body.max });
  return c.json(r);
});

newsRoute.post("/refresh/:entityId/dispatch", async (c) => {
  const entityId = c.req.param("entityId");
  if (c.env.WF_REFRESH_NEWS) {
    try {
      const wf = await c.env.WF_REFRESH_NEWS.create({ params: { entityId, triggered_by: c.get("email") } });
      return c.json({ ok: true, workflow_id: wf.id, dispatched: true });
    } catch (e) {
      return c.json({ ok: false, error: (e as Error).message }, 500);
    }
  }
  const r = await refreshEntityNews(c.env, entityId);
  return c.json({ ok: true, dispatched: false, ...r });
});

// ----------------- /api/news/reputability -----------------

newsRoute.post("/reputability/seed", async (c) => {
  const r = await ensureSeeded(c.env);
  return c.json(r);
});

newsRoute.get("/reputability", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT host, score, tier, country, notes, updated_at FROM source_reputability ORDER BY score DESC LIMIT 1000`,
  ).all();
  return c.json({ items: rows.results ?? [] });
});

// ----------------- /api/facts/:id/citations -----------------

factsCitationsRoute.get("/:id/citations", async (c) => {
  const factId = c.req.param("id");
  const fact = await c.env.DB.prepare(
    `SELECT id, entity_id, predicate, value_text, value_number, source_kind, source, evidence_url,
            confidence, verified_score, is_current, observed_at
       FROM facts WHERE id = ?`,
  ).bind(factId).first();
  if (!fact) return c.json({ error: "not_found" }, 404);
  const cits = await c.env.DB.prepare(
    `SELECT fc.id, fc.news_item_id, fc.quote, fc.contradicts, fc.created_at,
            ni.url, ni.host, ni.title, ni.source_name, ni.source_reputability,
            ni.published_at, ni.archive_url
       FROM fact_citations fc
       JOIN news_items ni ON ni.id = fc.news_item_id
      WHERE fc.fact_id = ?
      ORDER BY ni.source_reputability DESC, ni.published_at DESC`,
  ).bind(factId).all();
  // Competing facts: same entity + predicate, different fact id.
  const competing = await c.env.DB.prepare(
    `SELECT id, value_text, value_number, source_kind, evidence_url, confidence, verified_score
       FROM facts
      WHERE entity_id = ? AND predicate = ? AND id != ? AND is_current = 1`,
  ).bind((fact as { entity_id: string }).entity_id, (fact as { predicate: string }).predicate, factId).all();
  return c.json({ fact, citations: cits.results ?? [], competing_facts: competing.results ?? [] });
});

factsCitationsRoute.post("/:id/cite", async (c) => {
  const factId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { news_item_id?: string; quote?: string; contradicts?: 0 | 1 };
  if (!body.news_item_id) return c.json({ error: "missing_news_item_id" }, 400);
  // Validate both ends exist before inserting — fact_citations has no FK
  // constraints, so unchecked inserts can create orphan citation rows.
  const [factRow, newsRow] = await Promise.all([
    c.env.DB.prepare(`SELECT id FROM facts WHERE id = ? LIMIT 1`).bind(factId).first<{ id: string }>(),
    c.env.DB.prepare(`SELECT id FROM news_items WHERE id = ? LIMIT 1`).bind(body.news_item_id).first<{ id: string }>(),
  ]);
  if (!factRow) return c.json({ error: "fact_not_found" }, 404);
  if (!newsRow) return c.json({ error: "news_item_not_found" }, 404);
  const id = crypto.randomUUID();
  try {
    await c.env.DB.prepare(
      `INSERT INTO fact_citations(id, fact_id, news_item_id, quote, contradicts) VALUES(?, ?, ?, ?, ?)`,
    ).bind(id, factId, body.news_item_id, (body.quote ?? "").slice(0, 500), body.contradicts === 1 ? 1 : 0).run();
  } catch (e) {
    return c.json({ error: "insert_failed", message: (e as Error).message }, 500);
  }
  const score = await recomputeVerifiedScore(c.env, factId);
  return c.json({ ok: true, id, verified_score: score });
});

factsCitationsRoute.post("/:id/resolve-dispute", async (c) => {
  const factId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { competing_fact_id?: string; decision?: "canonical" | "rejected" | "merged"; notes?: string };
  const decision = body.decision ?? "canonical";
  // Constrain decisions to the supported set so operators can't silently
  // record states the server doesn't act on.
  if (!["canonical", "rejected", "merged"].includes(decision)) {
    return c.json({ error: "invalid_decision", allowed: ["canonical", "rejected", "merged"] }, 400);
  }
  if ((decision === "rejected" || decision === "merged") && !body.competing_fact_id) {
    return c.json({ error: "competing_fact_id_required", message: `decision=${decision} requires competing_fact_id` }, 400);
  }
  const resId = crypto.randomUUID();
  const actor = c.get("email") ?? null;

  // Load canonical fact for validation + audit. Reject unknown ids early.
  const canonical = await c.env.DB.prepare(
    `SELECT id, entity_id, predicate FROM facts WHERE id = ? LIMIT 1`,
  ).bind(factId).first<{ id: string; entity_id: string; predicate: string }>();
  if (!canonical) return c.json({ error: "fact_not_found" }, 404);

  // Validate competing_fact_id belongs to the SAME (entity_id, predicate)
  // family as the canonical fact. Prevents parameter-tampering that would
  // otherwise demote an unrelated fact.
  if (body.competing_fact_id) {
    const comp = await c.env.DB.prepare(
      `SELECT id, entity_id, predicate FROM facts WHERE id = ? LIMIT 1`,
    ).bind(body.competing_fact_id).first<{ id: string; entity_id: string; predicate: string }>();
    if (!comp) return c.json({ error: "competing_fact_not_found" }, 404);
    if (comp.entity_id !== canonical.entity_id || comp.predicate !== canonical.predicate || comp.id === canonical.id) {
      return c.json({ error: "competing_fact_mismatch", message: "competing_fact_id must share entity_id+predicate with the canonical fact" }, 400);
    }
  }

  // Atomic batch: resolution row + fact updates + entity_history append.
  const stmts: D1PreparedStatement[] = [];
  stmts.push(c.env.DB.prepare(
    `INSERT INTO fact_dispute_resolutions(id, fact_id, competing_fact_id, decision, notes, resolved_by)
     VALUES(?, ?, ?, ?, ?, ?)`,
  ).bind(resId, factId, body.competing_fact_id ?? null, decision, body.notes ?? null, actor));

  if (decision === "canonical") {
    if (body.competing_fact_id) {
      stmts.push(c.env.DB.prepare(
        `UPDATE facts SET is_current = 0, supersedes_fact_id = ? WHERE id = ?`,
      ).bind(factId, body.competing_fact_id));
    } else {
      // "Keep current as canonical": demote every OTHER current fact in the
      // same (entity_id, predicate) family so a single canonical remains.
      stmts.push(c.env.DB.prepare(
        `UPDATE facts SET is_current = 0, supersedes_fact_id = ?
          WHERE entity_id = ? AND predicate = ? AND id <> ? AND is_current = 1`,
      ).bind(factId, canonical.entity_id, canonical.predicate, factId));
    }
    stmts.push(c.env.DB.prepare(
      `UPDATE facts SET is_current = 1, supersedes_fact_id = NULL WHERE id = ?`,
    ).bind(factId));
  } else if (decision === "rejected") {
    // Operator rejects the competing fact in favor of the canonical: demote
    // the competitor and ensure the canonical stays current.
    stmts.push(c.env.DB.prepare(
      `UPDATE facts SET is_current = 0, supersedes_fact_id = ? WHERE id = ?`,
    ).bind(factId, body.competing_fact_id));
    stmts.push(c.env.DB.prepare(
      `UPDATE facts SET is_current = 1, supersedes_fact_id = NULL WHERE id = ?`,
    ).bind(factId));
  } else if (decision === "merged") {
    // Treat as equivalent: demote the competitor, keep canonical, and copy
    // the competitor's citations onto the canonical fact (idempotent).
    stmts.push(c.env.DB.prepare(
      `UPDATE facts SET is_current = 0, supersedes_fact_id = ? WHERE id = ?`,
    ).bind(factId, body.competing_fact_id));
    stmts.push(c.env.DB.prepare(
      `INSERT OR IGNORE INTO fact_citations(id, fact_id, news_item_id, quote, contradicts)
       SELECT lower(hex(randomblob(16))), ?, news_item_id, quote, contradicts
         FROM fact_citations WHERE fact_id = ?`,
    ).bind(factId, body.competing_fact_id));
    stmts.push(c.env.DB.prepare(
      `UPDATE facts SET is_current = 1, supersedes_fact_id = NULL WHERE id = ?`,
    ).bind(factId));
  }

  stmts.push(c.env.DB.prepare(
    `INSERT INTO entity_history (id, entity_id, action, predicate, old_value, new_value, source, evidence_url, changed_by, related_entity_id)
     VALUES (?, ?, 'fact_dispute_resolved', ?, ?, ?, 'news:dispute', ?, ?, NULL)`,
  ).bind(
    crypto.randomUUID(),
    canonical.entity_id,
    canonical.predicate ?? null,
    body.competing_fact_id ?? null,
    JSON.stringify({ decision, canonical_fact_id: factId, notes: body.notes ?? null }),
    "/api/facts/" + factId + "/resolve-dispute",
    actor,
  ));

  try {
    await c.env.DB.batch(stmts);
  } catch (e) {
    return c.json({ error: "resolve_failed", message: (e as Error).message }, 500);
  }
  // Recompute verified scores for the canonical AND every fact in the
  // same (entity_id, predicate) family so conflict badges stay synced.
  const family = await c.env.DB.prepare(
    `SELECT id FROM facts WHERE entity_id = ? AND predicate = ?`,
  ).bind(canonical.entity_id, canonical.predicate).all<{ id: string }>();
  const familyIds = new Set<string>([factId, ...((family.results ?? []).map((r) => r.id))]);
  if (body.competing_fact_id) familyIds.add(body.competing_fact_id);
  let score = 0;
  for (const fid of familyIds) {
    const s = await recomputeVerifiedScore(c.env, fid);
    if (fid === factId) score = s;
  }
  return c.json({ ok: true, resolution_id: resId, verified_score: score, rescored: familyIds.size });
});
