// Task #3: agent tool catalog.
//
// Every capability the agent has is a typed, schema-validated, server-side
// tool. The model never executes free-form SQL, free-form HTTP, or
// free-form code. Tools return a normalized shape:
//
//   { rows: Array<Record<string,unknown>>, citations: Array<{kind, ref_id, title, snippet?, url?, timestamp?}>, note?: string }
//
// The agent loop registers each citation with the CitationRegistry and
// substitutes [E:id]/[F:id]/etc markers into the assistant text.
//
// Citation marker kinds:
//   E entity   F fact   N news_item   T transcript   R relationship
//   M media    W web hit (Brave)

import type { Env } from "../types";
import { CitationRegistry, type CitationPayload } from "./registry";

export interface ToolResult {
  rows: Array<Record<string, unknown>>;
  citations: Array<CitationPayload>;
  note?: string;
}

export interface Tool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  handler: (env: Env, args: Record<string, unknown>, registry: CitationRegistry) => Promise<ToolResult>;
}

// Re-export the runtime tool-argument validator from its own module so it
// can be compiled standalone for the acceptance harness.
export { validateToolArgs } from "./tools-validation";
export type { ValidationResult, ValidationFailure, ValidationSuccess } from "./tools-validation";

// ---------- helpers ----------------------------------------------------------

function s(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function n(v: unknown, fallback = 0): number {
  const x = Number(v); return Number.isFinite(x) ? x : fallback;
}
function clip(v: string, max = 240): string {
  return v.length > max ? v.slice(0, max) + "…" : v;
}

async function tableExists(env: Env, name: string): Promise<boolean> {
  try {
    const r = await env.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).bind(name).first();
    return !!r;
  } catch { return false; }
}

// ---------- searchEntities ---------------------------------------------------

const searchEntities: Tool = {
  name: "searchEntities",
  description: "Search the unified entity graph (persons + orgs). Filter by role (investor/firm/founder/buyer/account/company), sector slug, geo slug, stage slug, free-text q, country_iso2, check size range. Sort by fit|intent|quality|updated. Returns entity_summary rows with stable [E:id] citations.",
  schema: {
    type: "object",
    properties: {
      q: { type: "string", description: "Free-text query against display_name/primary_domain/primary_email." },
      kind: { type: "string", enum: ["person", "org"] },
      role: { type: "string", description: "investor|firm|founder|buyer|account|company|executive|advisor" },
      sector: { type: "string", description: "Sector slug, e.g. 'climate', 'fintech', 'b2b-saas'." },
      geo: { type: "string", description: "Geo slug, e.g. 'europe', 'us', 'uk'." },
      stage: { type: "string", description: "Stage slug, e.g. 'seed', 'series-a'." },
      country_iso2: { type: "string" },
      check_min_usd: { type: "number" },
      check_max_usd: { type: "number" },
      sort: { type: "string", enum: ["fit", "intent", "quality", "updated"] },
      limit: { type: "number", maximum: 50 },
    },
  },
  handler: async (env, args, _reg) => {
    const { searchEntities: doSearch } = await import("../entities/query");
    const r = await doSearch(env, {
      q: s(args.q) || undefined,
      kind: args.kind === "person" || args.kind === "org" ? args.kind : undefined,
      has_role: s(args.role) || undefined,
      sector: s(args.sector) || undefined,
      geo: s(args.geo) || undefined,
      stage: s(args.stage) || undefined,
      country_iso2: s(args.country_iso2) || undefined,
      check_min_usd: typeof args.check_min_usd === "number" ? args.check_min_usd : undefined,
      check_max_usd: typeof args.check_max_usd === "number" ? args.check_max_usd : undefined,
      sort: (["fit","intent","quality","updated"].includes(s(args.sort)) ? s(args.sort) : "fit") as "fit"|"intent"|"quality"|"updated",
      limit: Math.min(n(args.limit, 12), 50),
    });
    const citations: CitationPayload[] = r.items.map((row) => ({
      kind: "E" as const,
      ref_id: String(row.entity_id ?? row.id ?? ""),
      title: String(row.display_name ?? row.name ?? "Unnamed entity"),
      snippet: clip([row.primary_role, row.primary_domain, row.country_iso2].filter(Boolean).join(" · ")),
      url: row.primary_domain ? `https://${row.primary_domain}` : undefined,
    })).filter((c) => c.ref_id);
    return { rows: r.items, citations };
  },
};

// ---------- getEntity --------------------------------------------------------

const getEntity: Tool = {
  name: "getEntity",
  description: "Load a single entity by id with roles, facts, channels, tags, summary. Cite the entity with [E:id] and individual facts with [F:fact_id].",
  schema: {
    type: "object",
    properties: { id: { type: "string" } },
    required: ["id"],
  },
  handler: async (env, args, _reg) => {
    const { loadEntity } = await import("../entities/query");
    const id = s(args.id);
    if (!id) return { rows: [], citations: [], note: "missing id" };
    const ent = await loadEntity(env, id);
    if (!ent) return { rows: [], citations: [], note: "entity not found" };
    const citations: CitationPayload[] = [
      { kind: "E", ref_id: ent.id, title: String(ent.entity.display_name ?? "Entity"), snippet: clip(String((ent.summary as Record<string, unknown> | null)?.headline ?? "")) },
    ];
    for (const f of ent.facts.slice(0, 25)) {
      citations.push({
        kind: "F", ref_id: f.id,
        title: f.predicate,
        snippet: clip(f.value_text ?? (f.value_number != null ? String(f.value_number) : JSON.stringify(f.value_json ?? null))),
      });
    }
    return { rows: [{ ...ent.entity, roles: ent.roles, channels: ent.channels, tags: ent.tags, facts: ent.facts, summary: ent.summary }], citations };
  },
};

// ---------- getFacts ---------------------------------------------------------

const getFacts: Tool = {
  name: "getFacts",
  description: "List facts (predicate/value rows) for an entity, optionally filtered by predicate. Each row gets a stable [F:id] citation.",
  schema: {
    type: "object",
    properties: { entity_id: { type: "string" }, predicate: { type: "string" }, limit: { type: "number" } },
    required: ["entity_id"],
  },
  handler: async (env, args) => {
    const id = s(args.entity_id);
    if (!id) return { rows: [], citations: [], note: "missing entity_id" };
    const where = ["entity_id = ?", "is_current = 1"];
    const binds: unknown[] = [id];
    if (args.predicate) { where.push("predicate = ?"); binds.push(s(args.predicate)); }
    const limit = Math.min(n(args.limit, 25), 100);
    binds.push(limit);
    const r = await env.DB.prepare(
      `SELECT id, predicate, value_text, value_number, value_json, source, source_kind, confidence, verified_score, observed_at
         FROM facts WHERE ${where.join(" AND ")} ORDER BY observed_at DESC LIMIT ?`,
    ).bind(...binds).all();
    const rows = r.results ?? [];
    const citations: CitationPayload[] = rows.map((f) => ({
      kind: "F", ref_id: String((f as { id: unknown }).id),
      title: String((f as { predicate: unknown }).predicate ?? "fact"),
      snippet: clip(String((f as { value_text?: unknown }).value_text ?? (f as { value_number?: unknown }).value_number ?? "")),
      timestamp: String((f as { observed_at?: unknown }).observed_at ?? ""),
    }));
    return { rows: rows as Array<Record<string, unknown>>, citations };
  },
};

// ---------- getCitations -----------------------------------------------------

const getCitations: Tool = {
  name: "getCitations",
  description: "Fetch news-article citations backing a fact. Returns news_items rows; cite each with [N:id].",
  schema: {
    type: "object",
    properties: { fact_id: { type: "string" } },
    required: ["fact_id"],
  },
  handler: async (env, args) => {
    const fid = s(args.fact_id);
    if (!fid) return { rows: [], citations: [], note: "missing fact_id" };
    if (!(await tableExists(env, "fact_citations"))) return { rows: [], citations: [], note: "news citations table not provisioned in this environment" };
    const r = await env.DB.prepare(
      `SELECT n.id, n.url, n.title, n.host, n.published_at, n.source_reputability, fc.quote, fc.contradicts
         FROM fact_citations fc
         JOIN news_items n ON n.id = fc.news_item_id
        WHERE fc.fact_id = ?
        ORDER BY n.published_at DESC LIMIT 25`,
    ).bind(fid).all();
    const rows = r.results ?? [];
    const citations: CitationPayload[] = rows.map((row) => {
      const r2 = row as Record<string, unknown>;
      return {
        kind: "N", ref_id: String(r2.id),
        title: String(r2.title ?? r2.host ?? "Article"),
        snippet: clip(String(r2.quote ?? "")),
        url: String(r2.url ?? ""),
        timestamp: String(r2.published_at ?? ""),
      };
    });
    return { rows: rows as Array<Record<string, unknown>>, citations };
  },
};

// ---------- getRelationships -------------------------------------------------

const getRelationships: Tool = {
  name: "getRelationships",
  description: "List edges incident to an entity. Each row is a relationship; cite with [R:id]. Optional kind filter (works_at|invested_in|board_of|...).",
  schema: {
    type: "object",
    properties: { entity_id: { type: "string" }, kind: { type: "string" }, limit: { type: "number" } },
    required: ["entity_id"],
  },
  handler: async (env, args) => {
    const id = s(args.entity_id);
    if (!id) return { rows: [], citations: [], note: "missing entity_id" };
    // The unified graph uses `relationships` from migration 110 (numeric ids
    // joined via entities table) OR a newer `entity_relationships` view.
    // We tolerate either by probing the simpler `relationships` join.
    if (!(await tableExists(env, "relationships"))) return { rows: [], citations: [], note: "relationships table not provisioned" };
    const where = ["(src = ? OR dst = ?)"];
    const binds: unknown[] = [id, id];
    if (args.kind) { where.push("kind = ?"); binds.push(s(args.kind)); }
    const limit = Math.min(n(args.limit, 25), 100);
    binds.push(limit);
    const r = await env.DB.prepare(
      `SELECT id, src, dst, kind, source, strength, started_at, ended_at, evidence_url
         FROM relationships WHERE ${where.join(" AND ")}
        ORDER BY strength DESC, id DESC LIMIT ?`,
    ).bind(...binds).all().catch(() => ({ results: [] as Record<string, unknown>[] }));
    const rows = (r.results ?? []) as Array<Record<string, unknown>>;
    const citations: CitationPayload[] = rows.map((row) => ({
      kind: "R", ref_id: String(row.id),
      title: `${row.kind} — ${row.src}→${row.dst}`,
      snippet: clip(String(row.source ?? "")),
      url: String(row.evidence_url ?? ""),
    }));
    return { rows, citations };
  },
};

// ---------- getPath ----------------------------------------------------------

const getPath: Tool = {
  name: "getPath",
  description: "Find a shortest relationship path between two entities (max 4 hops). Returns nodes + edges. Useful for intros.",
  schema: {
    type: "object",
    properties: { src: { type: "string" }, dst: { type: "string" }, max_hops: { type: "number" } },
    required: ["src", "dst"],
  },
  handler: async (env, args) => {
    const src = s(args.src), dst = s(args.dst);
    if (!src || !dst) return { rows: [], citations: [], note: "missing src/dst" };
    if (!(await tableExists(env, "relationships"))) return { rows: [], citations: [], note: "relationships table not provisioned" };
    const maxHops = Math.min(Math.max(1, n(args.max_hops, 4)), 5);
    // Simple BFS — bounded fan-out per layer to keep cost small.
    const visited = new Map<string, { parent: string | null; edgeKind: string | null }>();
    visited.set(src, { parent: null, edgeKind: null });
    let frontier = [src];
    for (let h = 0; h < maxHops && !visited.has(dst); h++) {
      const next: string[] = [];
      for (const node of frontier.slice(0, 50)) {
        const r = await env.DB.prepare(
          `SELECT src, dst, kind FROM relationships WHERE src = ? OR dst = ? LIMIT 200`,
        ).bind(node, node).all().catch(() => ({ results: [] as Record<string, unknown>[] }));
        for (const e of (r.results ?? []) as Array<{ src: string; dst: string; kind: string }>) {
          const neighbor = String(e.src) === node ? String(e.dst) : String(e.src);
          if (visited.has(neighbor)) continue;
          visited.set(neighbor, { parent: node, edgeKind: e.kind });
          next.push(neighbor);
          if (neighbor === dst) break;
        }
        if (visited.has(dst)) break;
      }
      frontier = next;
      if (!frontier.length) break;
    }
    if (!visited.has(dst)) return { rows: [], citations: [], note: "no path found" };
    const path: string[] = [];
    let cur: string | null = dst;
    while (cur) { path.unshift(cur); cur = visited.get(cur)?.parent ?? null; }
    return {
      rows: [{ src, dst, hops: path.length - 1, path }],
      citations: path.map((id) => ({ kind: "E" as const, ref_id: id, title: `Entity ${id}` })),
    };
  },
};

// ---------- getMedia ---------------------------------------------------------

const getMedia: Tool = {
  name: "getMedia",
  description: "List media items (images, avatars, logos) attached to an entity. Cite with [M:id]. Returns empty when no media table exists yet.",
  schema: {
    type: "object",
    properties: { entity_id: { type: "string" } },
    required: ["entity_id"],
  },
  handler: async (env, args) => {
    const id = s(args.entity_id);
    if (!id) return { rows: [], citations: [], note: "missing entity_id" };
    // Two possible tables depending on environment age. Probe both.
    for (const tbl of ["entity_media", "media"]) {
      if (await tableExists(env, tbl)) {
        const r = await env.DB.prepare(
          `SELECT id, kind, url, caption FROM ${tbl} WHERE entity_id = ? LIMIT 20`,
        ).bind(id).all().catch(() => null);
        if (r) {
          const rows = (r.results ?? []) as Array<Record<string, unknown>>;
          return {
            rows,
            citations: rows.map((m) => ({
              kind: "M" as const, ref_id: String(m.id),
              title: String(m.caption ?? m.kind ?? "media"),
              url: String(m.url ?? ""),
            })),
          };
        }
      }
    }
    return { rows: [], citations: [], note: "no media available for this entity" };
  },
};

// ---------- searchTranscripts ------------------------------------------------

const searchTranscripts: Tool = {
  name: "searchTranscripts",
  description: "Search transcript segments (podcasts, interviews, video). Cite with [T:segment_id] including a timestamp. Returns empty when transcript ingestion is not yet provisioned.",
  schema: {
    type: "object",
    properties: { q: { type: "string" }, entity_id: { type: "string" }, limit: { type: "number" } },
    required: ["q"],
  },
  handler: async (env, args) => {
    if (!(await tableExists(env, "transcript_segments")) && !(await tableExists(env, "transcripts"))) {
      return { rows: [], citations: [], note: "transcript ingestion not yet provisioned in this environment" };
    }
    const q = `%${s(args.q).toLowerCase()}%`;
    const limit = Math.min(n(args.limit, 10), 25);
    const tbl = (await tableExists(env, "transcript_segments")) ? "transcript_segments" : "transcripts";
    const r = await env.DB.prepare(
      `SELECT id, episode_title, speaker, content, started_at_seconds, url
         FROM ${tbl} WHERE lower(content) LIKE ? LIMIT ?`,
    ).bind(q, limit).all().catch(() => null);
    if (!r) return { rows: [], citations: [], note: "transcript search failed" };
    const rows = (r.results ?? []) as Array<Record<string, unknown>>;
    const citations: CitationPayload[] = rows.map((t) => ({
      kind: "T", ref_id: String(t.id),
      title: String(t.episode_title ?? "Transcript"),
      snippet: clip(String(t.content ?? "")),
      url: String(t.url ?? ""),
      timestamp: String(t.started_at_seconds ?? ""),
    }));
    return { rows, citations };
  },
};

// ---------- searchNews -------------------------------------------------------

const searchNews: Tool = {
  name: "searchNews",
  description: "Search news_items by free-text title/body or by entity_id (mentions). Cite with [N:id]. Filter by published_after (ISO date).",
  schema: {
    type: "object",
    properties: {
      q: { type: "string" }, entity_id: { type: "string" },
      published_after: { type: "string", description: "ISO date, e.g. 2025-05-01" },
      limit: { type: "number" },
    },
  },
  handler: async (env, args) => {
    if (!(await tableExists(env, "news_items"))) return { rows: [], citations: [], note: "news_items not provisioned" };
    const where: string[] = [];
    const binds: unknown[] = [];
    let sql: string;
    const limit = Math.min(n(args.limit, 15), 50);
    if (args.entity_id) {
      sql = `SELECT n.id, n.url, n.title, n.host, n.published_at, n.summary, n.body_excerpt, n.source_reputability
               FROM news_items n
               JOIN news_entity_mentions m ON m.news_item_id = n.id
              WHERE m.entity_id = ?`;
      binds.push(s(args.entity_id));
    } else {
      sql = `SELECT id, url, title, host, published_at, summary, body_excerpt, source_reputability FROM news_items`;
      if (args.q) {
        const q = `%${s(args.q).toLowerCase()}%`;
        where.push("(lower(title) LIKE ? OR lower(body_excerpt) LIKE ?)");
        binds.push(q, q);
      }
    }
    if (args.published_after) { where.push("published_at >= ?"); binds.push(s(args.published_after)); }
    if (where.length) sql += (sql.includes("WHERE") ? " AND " : " WHERE ") + where.join(" AND ");
    sql += " ORDER BY published_at DESC LIMIT ?";
    binds.push(limit);
    const r = await env.DB.prepare(sql).bind(...binds).all().catch(() => null);
    if (!r) return { rows: [], citations: [], note: "news search failed" };
    const rows = (r.results ?? []) as Array<Record<string, unknown>>;
    const citations: CitationPayload[] = rows.map((a) => ({
      kind: "N", ref_id: String(a.id),
      title: String(a.title ?? a.host ?? "Article"),
      snippet: clip(String(a.summary ?? a.body_excerpt ?? "")),
      url: String(a.url ?? ""),
      timestamp: String(a.published_at ?? ""),
    }));
    return { rows, citations };
  },
};

// ---------- compareEntities --------------------------------------------------

const compareEntities: Tool = {
  name: "compareEntities",
  description: "Compare two entities side-by-side: shared sectors/tags, shared check-size range, and last 5 facts each. Cite both with [E:id].",
  schema: {
    type: "object",
    properties: { left_id: { type: "string" }, right_id: { type: "string" } },
    required: ["left_id", "right_id"],
  },
  handler: async (env, args) => {
    const { loadEntity } = await import("../entities/query");
    const [a, b] = await Promise.all([loadEntity(env, s(args.left_id)), loadEntity(env, s(args.right_id))]);
    if (!a || !b) return { rows: [], citations: [], note: "one or both entities not found" };
    const aTags = new Set(a.tags.map((t) => `${t.taxonomy}:${t.slug}`));
    const shared = b.tags.map((t) => `${t.taxonomy}:${t.slug}`).filter((k) => aTags.has(k));
    return {
      rows: [{
        left: { id: a.id, name: a.entity.display_name, tags: a.tags.slice(0, 10), facts: a.facts.slice(0, 5) },
        right: { id: b.id, name: b.entity.display_name, tags: b.tags.slice(0, 10), facts: b.facts.slice(0, 5) },
        shared_tags: shared,
      }],
      citations: [
        { kind: "E", ref_id: a.id, title: String(a.entity.display_name ?? "Left") },
        { kind: "E", ref_id: b.id, title: String(b.entity.display_name ?? "Right") },
      ],
    };
  },
};

// ---------- runPersonaMatch --------------------------------------------------

const runPersonaMatch: Tool = {
  name: "runPersonaMatch",
  description: "Read pre-computed persona_matches for the given persona slug or id; returns top-N entities with fit_score + intent_score.",
  schema: {
    type: "object",
    properties: { persona: { type: "string", description: "persona slug or id" }, limit: { type: "number" } },
    required: ["persona"],
  },
  handler: async (env, args) => {
    if (!(await tableExists(env, "persona_matches"))) return { rows: [], citations: [], note: "persona_matches not provisioned" };
    const limit = Math.min(n(args.limit, 12), 50);
    const r = await env.DB.prepare(
      `SELECT pm.entity_id, pm.fit_score, pm.intent_score, s.display_name, s.primary_role, s.country_iso2
         FROM persona_matches pm
         JOIN personas p ON p.id = pm.persona_id
         LEFT JOIN entity_summary s ON s.entity_id = pm.entity_id
        WHERE p.id = ?1 OR p.slug = ?1 OR p.name = ?1
        ORDER BY pm.fit_score DESC LIMIT ?2`,
    ).bind(s(args.persona), limit).all().catch(() => null);
    if (!r) return { rows: [], citations: [], note: "persona match query failed" };
    const rows = (r.results ?? []) as Array<Record<string, unknown>>;
    return {
      rows,
      citations: rows.map((row) => ({
        kind: "E" as const, ref_id: String(row.entity_id),
        title: String(row.display_name ?? "Entity"),
        snippet: `fit=${row.fit_score} intent=${row.intent_score}`,
      })),
    };
  },
};

// ---------- runPrediction ----------------------------------------------------

const runPrediction: Tool = {
  name: "runPrediction",
  description: "Run the link-yield predictor on a URL — returns expected_yield_score 0..1 and predicted_kind (team_page|bio|...). Use sparingly; this is a pre-crawl heuristic, not a database lookup.",
  schema: {
    type: "object",
    properties: { url: { type: "string" }, method: { type: "string" }, depth: { type: "number" }, link_text: { type: "string" } },
    required: ["url"],
  },
  handler: async (env, args) => {
    try {
      const { predictYield } = await import("../discovery/predictYield");
      const v = await predictYield(env, {
        url: s(args.url),
        method: s(args.method, "manual"),
        depth: n(args.depth, 1),
        link_text: s(args.link_text),
      });
      return { rows: [v as unknown as Record<string, unknown>], citations: [] };
    } catch (e) {
      return { rows: [], citations: [], note: `prediction unavailable: ${(e as Error).message}` };
    }
  },
};

// ---------- runDDScan --------------------------------------------------------

const runDDScan: Tool = {
  name: "runDDScan",
  description: "Read the most recent due-diligence scan for an entity (risk band + findings counts). Does NOT trigger a fresh scan — use the dashboard for that.",
  schema: {
    type: "object",
    properties: { entity_id: { type: "string" } },
    required: ["entity_id"],
  },
  handler: async (env, args) => {
    if (!(await tableExists(env, "dd_scans"))) return { rows: [], citations: [], note: "dd_scans not provisioned" };
    const r = await env.DB.prepare(
      `SELECT id, entity_id, risk_score, risk_band, sanctions_count, adverse_media_count, regulatory_count, litigation_count, scanned_at
         FROM dd_scans WHERE entity_id = ? ORDER BY scanned_at DESC LIMIT 1`,
    ).bind(s(args.entity_id)).first<Record<string, unknown>>().catch(() => null);
    if (!r) return { rows: [], citations: [], note: "no DD scan on record for this entity" };
    return {
      rows: [r],
      citations: [{ kind: "E", ref_id: String(r.entity_id), title: `DD scan — risk ${r.risk_band}` }],
    };
  },
};

// ---------- getAuthenticity --------------------------------------------------

const getAuthenticity: Tool = {
  name: "getAuthenticity",
  description: "Return an authenticity / quality signal for an entity (quality_score + verified-fact ratio + last DD risk band).",
  schema: {
    type: "object",
    properties: { entity_id: { type: "string" } },
    required: ["entity_id"],
  },
  handler: async (env, args) => {
    const id = s(args.entity_id);
    if (!id) return { rows: [], citations: [], note: "missing entity_id" };
    const ent = await env.DB.prepare(`SELECT id, display_name, quality_score FROM u_entities WHERE id = ?`).bind(id).first<Record<string, unknown>>().catch(() => null);
    if (!ent) return { rows: [], citations: [], note: "entity not found" };
    const fc = await env.DB.prepare(
      `SELECT COUNT(*) AS n, AVG(COALESCE(verified_score,0)) AS avg_v FROM facts WHERE entity_id = ? AND is_current = 1`,
    ).bind(id).first<{ n: number; avg_v: number }>().catch(() => ({ n: 0, avg_v: 0 }));
    let band: string | null = null;
    if (await tableExists(env, "dd_scans")) {
      const dd = await env.DB.prepare(`SELECT risk_band FROM dd_scans WHERE entity_id = ? ORDER BY scanned_at DESC LIMIT 1`).bind(id).first<{ risk_band: string }>().catch(() => null);
      band = dd?.risk_band ?? null;
    }
    return {
      rows: [{ entity_id: id, display_name: ent.display_name, quality_score: ent.quality_score, fact_count: fc?.n ?? 0, avg_verified: fc?.avg_v ?? 0, dd_risk_band: band }],
      citations: [{ kind: "E", ref_id: id, title: String(ent.display_name ?? "Entity") }],
    };
  },
};

// ---------- aggregate --------------------------------------------------------

const aggregate: Tool = {
  name: "aggregate",
  description: "Group-by aggregation over entity_summary. dimension ∈ {primary_role, country_iso2, sector, stage}. Optional role/sector/country filters.",
  schema: {
    type: "object",
    properties: {
      dimension: { type: "string", enum: ["primary_role", "country_iso2", "sector", "stage"] },
      role: { type: "string" }, country_iso2: { type: "string" }, sector: { type: "string" },
      limit: { type: "number" },
    },
    required: ["dimension"],
  },
  handler: async (env, args) => {
    // Allowlist BEFORE interpolation — `dim` is interpolated directly into
    // the SQL string (D1 doesn't parameterize identifiers). Any future
    // addition to this list MUST be a literal column / taxonomy slug.
    const ALLOWED_DIMS = new Set(["primary_role", "country_iso2", "sector", "stage"]);
    const dim = s(args.dimension);
    const limit = Math.min(n(args.limit, 20), 50);
    if (!ALLOWED_DIMS.has(dim)) {
      return { rows: [], citations: [], note: "invalid dimension" };
    }
    const where: string[] = ["s.status = 'active'"];
    const binds: unknown[] = [];
    if (args.role)         { where.push("s.primary_role = ?"); binds.push(s(args.role)); }
    if (args.country_iso2) { where.push("s.country_iso2 = ?"); binds.push(s(args.country_iso2).toUpperCase()); }
    let sql: string;
    if (dim === "sector" || dim === "stage") {
      sql = `SELECT t.slug AS bucket, COUNT(*) AS n
               FROM entity_summary s
               JOIN entity_tags t ON t.entity_id = s.entity_id AND t.taxonomy = ?
              WHERE ${where.join(" AND ")}
              GROUP BY t.slug ORDER BY n DESC LIMIT ?`;
      binds.unshift(dim);
      binds.push(limit);
    } else {
      sql = `SELECT s.${dim} AS bucket, COUNT(*) AS n
               FROM entity_summary s
              WHERE ${where.join(" AND ")} AND s.${dim} IS NOT NULL
              GROUP BY s.${dim} ORDER BY n DESC LIMIT ?`;
      binds.push(limit);
    }
    const r = await env.DB.prepare(sql).bind(...binds).all().catch(() => null);
    if (!r) return { rows: [], citations: [], note: "aggregate query failed" };
    return { rows: (r.results ?? []) as Array<Record<string, unknown>>, citations: [] };
  },
};

// ---------- summarizeEntity --------------------------------------------------

const summarizeEntity: Tool = {
  name: "summarizeEntity",
  description: "Return the cached entity_summary row for an entity (headline, thesis, sector mix, check-size band, signal flags). Cite with [E:id].",
  schema: {
    type: "object",
    properties: { entity_id: { type: "string" } },
    required: ["entity_id"],
  },
  handler: async (env, args) => {
    const id = s(args.entity_id);
    if (!id) return { rows: [], citations: [], note: "missing entity_id" };
    const r = await env.DB.prepare(`SELECT * FROM entity_summary WHERE entity_id = ?`).bind(id).first<Record<string, unknown>>().catch(() => null);
    if (!r) return { rows: [], citations: [], note: "no summary on record" };
    return { rows: [r], citations: [{ kind: "E", ref_id: id, title: String(r.display_name ?? "Entity"), snippet: clip(String(r.headline ?? "")) }] };
  },
};

// ---------- findIntros -------------------------------------------------------

const findIntros: Tool = {
  name: "findIntros",
  description: "Suggest intro paths from the operator's network to a target entity. Wraps the shortest-path search through the relationships graph (max 4 hops, intro-friendly edge kinds).",
  schema: {
    type: "object",
    properties: { target_entity_id: { type: "string" }, from_entity_id: { type: "string" }, max_hops: { type: "number" } },
    required: ["target_entity_id"],
  },
  handler: async (env, args) => {
    return getPath.handler(env, { src: s(args.from_entity_id), dst: s(args.target_entity_id), max_hops: args.max_hops ?? 4 }, new CitationRegistry());
  },
};

// ---------- webSearch (in-house fallback) ------------------------------------
//
// Task #5: routed through services/searchBootstrap (DuckDuckGo/Mojeek HTML
// scraping via the in-house fetcher) — the paid Brave Search API was
// removed.

const webSearch: Tool = {
  name: "webSearch",
  description: "Fallback web search via DuckDuckGo/Mojeek HTML when the database plausibly lacks coverage. Each hit gets a distinct [W:idx] citation. Web hits are enqueued for ingestion so future asks of the same question hit the DB.",
  schema: {
    type: "object",
    properties: { q: { type: "string" }, count: { type: "number" } },
    required: ["q"],
  },
  handler: async (env, args, reg) => {
    const q = s(args.q);
    const count = Math.min(Math.max(1, n(args.count, 5)), 10);
    try {
      const { bootstrapEntity } = await import("../services/searchBootstrap");
      const hits = (await bootstrapEntity(env, { name: q, limit: count })).slice(0, count);
      if (!hits.length) return { rows: [], citations: [], note: "no web hits" };
      // Fire-and-forget enqueue for future ingestion. Skip if the LEAD_QUEUE
      // binding is in a weird state; this MUST NOT block the agent.
      try {
        for (const h of hits) {
          if (!h.url) continue;
          await env.LEAD_QUEUE.send({ jobId: crypto.randomUUID(), kind: "url", target: h.url, config: { discovery: true, agent_web_search: true } });
        }
      } catch { /* never fail the tool on enqueue failure */ }
      const citations: CitationPayload[] = [];
      const rows = hits.map((h) => {
        const payload: CitationPayload = {
          kind: "W", ref_id: "",
          title: h.title || h.url || "Web result",
          snippet: clip(`${h.kind} (${h.source_provider})`),
          url: h.url,
        };
        const marker = reg.registerWeb(payload);
        const refId = marker.split(":")[1];
        payload.ref_id = refId;
        citations.push(payload);
        return { idx: Number(refId), marker, url: payload.url, title: payload.title, snippet: payload.snippet };
      });
      return { rows, citations, note: "web fallback — not in database yet" };
    } catch (e) {
      return { rows: [], citations: [], note: `web search failed: ${(e as Error).message}` };
    }
  },
};

// ---------- catalog ----------------------------------------------------------

export const TOOLS: Tool[] = [
  searchEntities, getEntity, getFacts, getCitations, getRelationships, getPath, getMedia,
  searchTranscripts, searchNews, compareEntities, runPersonaMatch, runPrediction, runDDScan,
  getAuthenticity, aggregate, summarizeEntity, findIntros, webSearch,
];

export function getTool(name: string): Tool | null {
  return TOOLS.find((t) => t.name === name) ?? null;
}

export function toolManifest(): Array<{ name: string; description: string; schema: Record<string, unknown> }> {
  return TOOLS.map((t) => ({ name: t.name, description: t.description, schema: t.schema }));
}
