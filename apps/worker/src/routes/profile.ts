// Task #3: Profile classifier API.
//
//   GET  /api/profile/:id                       — full profile axes + flags + summary
//   POST /api/profile/classify/:id              — classify inline (blocks on AI)
//   POST /api/profile/classify/:id/dispatch     — durable workflow dispatch
//   POST /api/profile/:id/refresh-government    — refresh appointments + donations
//   POST /api/profile/:id/override              — { field, value, note } operator pin
//   POST /api/profile/:id/donations             — { rows: [...] } manual import
//   GET  /api/profile/:id/donations             — list donations
//   GET  /api/profile/:id/appointments          — list government appointments
//   GET  /api/profile/:id/evidence              — ?axis=… evidence quotes
//   GET  /api/profile/politicians               — list politicians (filters + sort)

import { Hono } from "hono";
import type { Env } from "../types";
import { getProfileAxes, setManualOverride, getEvidence } from "../profile/repo";
import { classifyEntity, CLASSIFIER_VERSION } from "../profile/classifier";
import { refreshGovernmentAppointments } from "../profile/government";
import { refreshDonations } from "../profile/donations";
import { isBadEntityName, displayFromDomain } from "../entities/badName";

export const profileRoute = new Hono<{ Bindings: Env; Variables: { email: string } }>();

function parseJsonField<T>(s: string | null): T | null {
  if (!s) return null;
  try { return JSON.parse(s) as T; } catch { return null; }
}

// ---------------- GET /:id ----------------

profileRoute.get("/politicians", async (c) => {
  // Note: route is defined before /:id so Hono doesn't shadow it.
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? "0"), 0);
  const minInfluence = Number(c.req.query("min_influence") ?? "0");
  const party = c.req.query("party")?.toLowerCase() ?? null;
  const jurisdiction = c.req.query("jurisdiction") ?? null;
  const ideologyAxis = c.req.query("axis") ?? null; // left_right | lib_auth | …
  const ideologyMin = c.req.query("axis_min") != null ? Number(c.req.query("axis_min")) : null;
  const ideologyMax = c.req.query("axis_max") != null ? Number(c.req.query("axis_max")) : null;

  let extraJoin = "";
  const where: string[] = [
    "u.status = 'active'",
    "(a.is_pep = 1 OR a.is_government_official = 1 OR a.primary_type IN ('politician','government_official'))",
    "COALESCE(a.political_influence, 0) >= ?",
  ];
  const bind: unknown[] = [minInfluence];

  if (party) {
    extraJoin += " JOIN government_appointments ga ON ga.entity_id = u.id ";
    where.push("lower(ga.party) LIKE ?");
    bind.push(`%${party}%`);
  }
  if (jurisdiction) {
    if (!extraJoin.includes("government_appointments")) {
      extraJoin += " JOIN government_appointments ga ON ga.entity_id = u.id ";
    }
    where.push("ga.jurisdiction = ?");
    bind.push(jurisdiction);
  }
  if (ideologyAxis && ["left_right","lib_auth","prog_cons","glob_nat","sec_rel"].includes(ideologyAxis)) {
    if (ideologyMin != null) { where.push(`a.${ideologyAxis} >= ?`); bind.push(ideologyMin); }
    if (ideologyMax != null) { where.push(`a.${ideologyAxis} <= ?`); bind.push(ideologyMax); }
  }

  const sql = `SELECT DISTINCT u.id, u.display_name, u.kind, u.primary_domain,
       a.primary_type, a.primary_type_conf,
       a.left_right, a.lib_auth, a.prog_cons, a.glob_nat, a.sec_rel, a.ideology_conf,
       a.political_influence, a.media_influence, a.network_centrality, a.capital_influence,
       a.is_pep, a.is_government_official
     FROM entity_profile_axes a
     JOIN u_entities u ON u.id = a.entity_id
     ${extraJoin}
     WHERE ${where.join(" AND ")}
     ORDER BY COALESCE(a.political_influence, 0) DESC, u.display_name ASC
     LIMIT ? OFFSET ?`;
  const rows = await c.env.DB.prepare(sql).bind(...bind, limit, offset).all();
  return c.json({ items: rows.results ?? [], meta: { limit, offset } });
});

// ---- Tolerant profile envelope ------------------------------------------
//
// GET /api/profile/:id returns a stable, fully-shaped envelope. Every
// sub-query runs in parallel under Promise.allSettled — a single broken
// table (AV intelligence, predictions, dd_scores) appends its slice key
// to `missing_subsystems` and the slice itself comes back as [] / null,
// never a 503. The envelope shape is contracted: missing data is an
// empty array / null, never an absent key.
//
// The response is owner-scoped KV-cached for 60 s. ?bust=1 invalidates.

interface MissingTracker { missing: string[] }

async function settled<T>(p: Promise<T>, tracker: MissingTracker, slice: string, fallback: T): Promise<T> {
  try {
    return await p;
  } catch (e) {
    console.warn(`profile envelope: slice "${slice}" failed:`, (e as Error).message);
    tracker.missing.push(slice);
    return fallback;
  }
}

interface EntityRowMin {
  id: string; kind: string; display_name: string | null;
  primary_url: string | null; primary_domain: string | null;
  status: string; created_at: string; updated_at: string;
}

async function buildProfileEnvelope(env: Env, id: string): Promise<{
  found: boolean;
  body: Record<string, unknown>;
}> {
  const ent = await env.DB.prepare(
    `SELECT id, kind, display_name, primary_url, primary_domain, status, created_at, updated_at
       FROM u_entities WHERE id = ?`,
  ).bind(id).first<EntityRowMin>().catch(() => null);
  if (!ent) return { found: false, body: { error: "entity_not_found" } };

  const tracker: MissingTracker = { missing: [] };

  // Fan out every sub-query in parallel. Each .all() / .first() lives
  // behind settled() so a single broken table never poisons the
  // response.
  const [
    factsRows,
    rolesRows,
    channelsRows,
    tagsRows,
    relEdgesIn,
    relEdgesOut,
    newsRows,
    axesRow,
    riskRow,
    predictionsRows,
    summaryRow,
    appointmentsRows,
    donationsAggRows,
  ] = await Promise.all([
    settled(
      env.DB.prepare(
        `SELECT id, predicate, value_text, value_number, value_json, value_entity_id,
                source, source_kind, confidence, verified_score, evidence_url,
                observed_at, is_current
           FROM facts WHERE entity_id = ? AND is_current = 1
           ORDER BY observed_at DESC LIMIT 500`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "facts", [] as Array<Record<string, unknown>>,
    ),
    settled(
      env.DB.prepare(
        `SELECT role, is_primary, confidence, source FROM entity_roles WHERE entity_id = ?`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "roles", [] as Array<Record<string, unknown>>,
    ),
    settled(
      env.DB.prepare(
        `SELECT kind, canonical, display, is_primary, is_verified, is_dnc, confidence
           FROM channels WHERE entity_id = ?`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "channels", [] as Array<Record<string, unknown>>,
    ),
    settled(
      env.DB.prepare(
        `SELECT taxonomy, slug, weight, source FROM entity_tags WHERE entity_id = ?`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "tags", [] as Array<Record<string, unknown>>,
    ),
    settled(
      // Inbound edges (this entity is dst).
      env.DB.prepare(
        `SELECT re.kind, re.src_entity_id AS other_id, re.evidence_url, re.source,
                u.display_name AS other_name, u.kind AS other_kind, u.primary_domain
           FROM rel_edges re
           LEFT JOIN u_entities u ON u.id = re.src_entity_id
          WHERE re.dst_entity_id = ?
          ORDER BY re.kind LIMIT 500`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "relationships_in", [] as Array<Record<string, unknown>>,
    ),
    settled(
      // Outbound edges (this entity is src).
      env.DB.prepare(
        `SELECT re.kind, re.dst_entity_id AS other_id, re.evidence_url, re.source,
                u.display_name AS other_name, u.kind AS other_kind, u.primary_domain
           FROM rel_edges re
           LEFT JOIN u_entities u ON u.id = re.dst_entity_id
          WHERE re.src_entity_id = ?
          ORDER BY re.kind LIMIT 500`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "relationships_out", [] as Array<Record<string, unknown>>,
    ),
    settled(
      env.DB.prepare(
        `SELECT ni.id, ni.title, ni.url, ni.host, ni.published_at, ni.sentiment,
                ni.source_reputability, ni.summary
           FROM news_entity_mentions nem
           JOIN news_items ni ON ni.id = nem.news_item_id
          WHERE nem.entity_id = ?
          ORDER BY COALESCE(ni.published_at, ni.fetched_at) DESC
          LIMIT 30`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "news", [] as Array<Record<string, unknown>>,
    ),
    settled(getProfileAxes(env, id), tracker, "classification", null),
    settled(
      env.DB.prepare(
        `SELECT risk_score, trust_score, risk_band, ai_summary, computed_at
           FROM entity_risk_scores WHERE entity_id = ?`,
      ).bind(id).first<Record<string, unknown>>(),
      tracker, "risk", null,
    ),
    settled(
      env.DB.prepare(
        `SELECT metric, probability, horizon, generated_at
           FROM predictions WHERE entity_id = ?
           ORDER BY generated_at DESC LIMIT 20`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "predictions", [] as Array<Record<string, unknown>>,
    ),
    settled(
      env.DB.prepare(
        `SELECT quality_score, rebuilt_at FROM entity_summary WHERE entity_id = ?`,
      ).bind(id).first<{ quality_score: number | null; rebuilt_at: string | null }>(),
      tracker, "summary", null,
    ),
    settled(
      env.DB.prepare(
        `SELECT id, title, body, jurisdiction, party, seniority, start_date, end_date,
                is_current, source, source_url
           FROM government_appointments WHERE entity_id = ?
          ORDER BY is_current DESC, COALESCE(start_date, '') DESC LIMIT 50`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "appointments", [] as Array<Record<string, unknown>>,
    ),
    settled(
      env.DB.prepare(
        `SELECT recipient_party, COUNT(*) AS n, COALESCE(SUM(amount_usd), 0) AS total
           FROM political_donations WHERE entity_id = ? GROUP BY recipient_party`,
      ).bind(id).all().then((r) => r.results ?? []),
      tracker, "donations", [] as Array<Record<string, unknown>>,
    ),
  ]);

  // Inflate value_json blobs (D1 returns them as strings).
  for (const f of factsRows as Array<{ value_json: unknown }>) {
    if (typeof f.value_json === "string") {
      try { f.value_json = JSON.parse(f.value_json); } catch { /* leave as string */ }
    }
  }

  // Group rel edges into the contracted shape. team_members are people
  // with a works_at edge pointing AT this org; portfolio is org targets
  // of invested_in edges leaving this entity.
  const relIn = relEdgesIn as Array<{ kind: string; other_id: string; other_name: string | null; other_kind: string | null; primary_domain: string | null; evidence_url: string | null }>;
  const relOut = relEdgesOut as Array<{ kind: string; other_id: string; other_name: string | null; other_kind: string | null; primary_domain: string | null; evidence_url: string | null }>;
  const relationships: Record<string, Array<Record<string, unknown>>> = {
    invested_in: [], works_at: [], founded: [], advisor_to: [], partner_of: [],
  };
  for (const e of relOut) {
    if (e.kind === "invested_in") relationships.invested_in.push(e);
    else if (e.kind === "works_at") relationships.works_at.push(e);
    else if (e.kind === "founded") relationships.founded.push(e);
    else if (e.kind === "advisor_to" || e.kind === "board_of") relationships.advisor_to.push(e);
    else if (e.kind === "partner_at" || e.kind === "partner_with") relationships.partner_of.push(e);
  }
  const team_members = relIn.filter((e) => e.kind === "works_at" || e.kind === "partner_at");
  const portfolio = relOut.filter((e) => e.kind === "invested_in");

  // News rows do double duty as media_appearances — same source table,
  // different rendering. Keep both keys populated so the contract holds.
  const news = newsRows as Array<Record<string, unknown>>;
  const media_appearances = news;

  // last_enriched_at: prefer the latest fact observed_at, fall back to
  // summary rebuilt_at, then entity updated_at.
  const latestFactObserved = (factsRows as Array<{ observed_at?: string }>).reduce<string | null>(
    (acc, f) => (f.observed_at && (!acc || f.observed_at > acc)) ? f.observed_at : acc,
    null,
  );
  const last_enriched_at = latestFactObserved
    ?? (summaryRow as { rebuilt_at: string | null } | null)?.rebuilt_at
    ?? ent.updated_at
    ?? null;

  // confidence_score: weighted by fact verified_score when present, else
  // mean of fact.confidence. Used by the dashboard to decide whether to
  // surface the 🪄 auto-correct button.
  const confs = (factsRows as Array<{ confidence: number; verified_score: number | null }>)
    .map((f) => f.verified_score ?? f.confidence ?? 0)
    .filter((n) => typeof n === "number" && Number.isFinite(n));
  const confidence_score = confs.length
    ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 100) / 100
    : null;

  const a = axesRow as Record<string, unknown> | null;
  const classification = a ? {
    primary_type: a.primary_type ?? null,
    primary_type_conf: a.primary_type_conf ?? null,
    type_weights: parseJsonField<Record<string, number>>((a.type_weights_json as string) ?? null),
    classifier_version: a.classifier_version ?? null,
    classified_at: a.classified_at ?? null,
    summary: a.summary_text ?? null,
    ideology: {
      left_right: a.left_right ?? null,
      lib_auth: a.lib_auth ?? null,
      prog_cons: a.prog_cons ?? null,
      glob_nat: a.glob_nat ?? null,
      sec_rel: a.sec_rel ?? null,
      confidence: a.ideology_conf ?? null,
    },
    influence: {
      network_centrality: a.network_centrality ?? null,
      media_influence: a.media_influence ?? null,
      capital_influence: a.capital_influence ?? null,
      political_influence: a.political_influence ?? null,
    },
    interests: parseJsonField((a.interests_json as string) ?? null),
    hobbies: parseJsonField((a.hobbies_json as string) ?? null),
    causes: parseJsonField((a.causes_json as string) ?? null),
    flags: {
      is_pep: !!a.is_pep,
      is_government_official: !!a.is_government_official,
      is_lobbyist: !!a.is_lobbyist,
    },
    manual_overrides: parseJsonField((a.manual_override_json as string) ?? null),
    evidence_count: a.evidence_count ?? 0,
  } : null;

  const r = riskRow as { risk_score?: number | null; trust_score?: number | null; risk_band?: string | null; ai_summary?: string | null; computed_at?: string | null } | null;
  const risk = r ? {
    risk_score: r.risk_score ?? null,
    risk_band: r.risk_band ?? null,
    ai_summary: r.ai_summary ?? null,
    computed_at: r.computed_at ?? null,
  } : null;
  const authenticity = r ? { trust_score: r.trust_score ?? null } : null;

  // Display-name suggestion: server-side computed once so every
  // consumer (profile-tab, firm-detail, investor-detail) renders the
  // same fallback when entities.display_name looks like a type string.
  const nameIsBad = isBadEntityName(ent.display_name);
  const display_name_fallback = nameIsBad
    ? (displayFromDomain(ent.primary_url ?? ent.primary_domain) ?? null)
    : null;

  const body: Record<string, unknown> = {
    entity: {
      id: ent.id,
      kind: ent.kind,
      display_name: ent.display_name,
      primary_url: ent.primary_url,
      primary_domain: ent.primary_domain,
      status: ent.status,
      // Header-rendering hints — computed once, never mutated by this
      // route. The frontend chooses what to render; the backend writes
      // nothing (Task #5 owns the backfill).
      display_name_is_bad: nameIsBad,
      display_name_fallback,
    },
    facts: factsRows,
    roles: rolesRows,
    channels: channelsRows,
    tags: tagsRows,
    relationships,
    team_members,
    portfolio,
    news,
    media_appearances,
    classification,
    risk,
    authenticity,
    predictions: predictionsRows,
    last_enriched_at,
    confidence_score,
    missing_subsystems: tracker.missing,

    // ---- Backward-compat surface (consumed by profile-tab.js) ----
    // The classifier UI was the first user of this route; preserving
    // these flat keys lets the existing tab render without changes.
    classifier_version: a?.classifier_version ?? null,
    classified_at: a?.classified_at ?? null,
    refreshed_at: a?.refreshed_at ?? null,
    primary_type: a?.primary_type ?? null,
    primary_type_conf: a?.primary_type_conf ?? null,
    type_weights: classification?.type_weights ?? null,
    ideology: classification?.ideology ?? null,
    influence: classification?.influence ?? null,
    interests: classification?.interests ?? null,
    hobbies: classification?.hobbies ?? null,
    causes: classification?.causes ?? null,
    summary: classification?.summary ?? null,
    flags: classification?.flags ?? { is_pep: false, is_government_official: false, is_lobbyist: false },
    manual_overrides: classification?.manual_overrides ?? null,
    evidence_count: classification?.evidence_count ?? 0,
    appointments: appointmentsRows,
    donations_by_party: donationsAggRows,
  };
  return { found: true, body };
}

profileRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const email = (c.var.email ?? "").toLowerCase();
  const bust = c.req.query("bust") === "1";
  const cacheKey = `profile:${email}:${id}`;

  if (c.env.SCRAPE_CACHE) {
    if (bust) {
      // Deterministic invalidation: drop the stale entry before we
      // serve the rebuilt payload, so a concurrent non-bust read
      // can't race the async write below and observe stale data.
      try { await c.env.SCRAPE_CACHE.delete(cacheKey); }
      catch (e) { console.warn("profile cache delete failed:", (e as Error).message); }
    } else {
      try {
        const hit = await c.env.SCRAPE_CACHE.get(cacheKey);
        if (hit) {
          return new Response(hit, {
            status: 200,
            headers: { "content-type": "application/json", "x-cache": "hit" },
          });
        }
      } catch (e) {
        // KV outage must never fail the request.
        console.warn("profile cache get failed:", (e as Error).message);
      }
    }
  }

  const { found, body } = await buildProfileEnvelope(c.env, id);
  if (!found) return c.json(body, 404);

  const payload = JSON.stringify(body);
  if (c.env.SCRAPE_CACHE) {
    const put = c.env.SCRAPE_CACHE.put(cacheKey, payload, { expirationTtl: 60 }).catch((e) => {
      console.warn("profile cache put failed:", (e as Error).message);
    });
    // When busting we await the write so the next read is guaranteed
    // to see the fresh payload; otherwise fire-and-forget for latency.
    if (bust) { await put; } else { c.executionCtx.waitUntil(put); }
  }
  return new Response(payload, {
    status: 200,
    headers: { "content-type": "application/json", "x-cache": "miss" },
  });
});

// ---------------- POST /classify/:id ----------------

profileRoute.post("/classify/:id", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
  try {
    const r = await classifyEntity(c.env, id, { force: !!body.force });
    return c.json({ ok: true, ...r, classifier_version: CLASSIFIER_VERSION });
  } catch (e) {
    return c.json({ ok: false, error: (e as Error).message }, 400);
  }
});

profileRoute.post("/classify/:id/dispatch", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ force?: boolean; refreshGovernment?: boolean }>().catch(() => ({} as { force?: boolean; refreshGovernment?: boolean }));
  if (!c.env.WF_CLASSIFY_ENTITY) return c.json({ ok: false, error: "workflow_not_bound" }, 503);
  const wf = await c.env.WF_CLASSIFY_ENTITY.create({ params: { entityId: id, force: !!body.force, refreshGovernment: !!body.refreshGovernment } });
  return c.json({ ok: true, workflow_id: wf.id });
});

// ---------------- POST /:id/fill (Task #3 AI Profile Filler) ----------------

profileRoute.post("/:id/fill", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ force?: boolean }>().catch(() => ({} as { force?: boolean }));
  const email = c.var.email;

  // Owner isolation (spec "Owner isolation"): manual triggers require a
  // resolved Access JWT email AND that email must be on the operator
  // allowlist. The site is single-operator today (see ADMIN_EMAILS in
  // routes/relationships.ts and the allowlist in replit.md); facts are
  // global but the trigger itself is operator-scoped so authenticated-
  // but-non-admin Access users can't burn AI spend on arbitrary IDs.
  const ADMIN_EMAILS = new Set(["guillaumelauzier@gmail.com"]);
  if (!email) {
    return c.json({ ok: false, error: "unauthenticated" }, 401);
  }
  if (!ADMIN_EMAILS.has(email.toLowerCase())) {
    return c.json({ ok: false, error: "forbidden" }, 403);
  }
  // Confirm the entity exists + is active before incurring any AI cost
  // or rate-limit state. (Profile facts are global per spec, but the
  // trigger itself is operator-scoped.)
  const ent = await c.env.DB.prepare(
    `SELECT id FROM u_entities WHERE id = ? AND status = 'active'`,
  ).bind(id).first<{ id: string }>().catch(() => null);
  if (!ent) return c.json({ ok: false, error: "entity_not_found" }, 404);

  // Per-(user, entity) 1 fill/min throttle so the manual endpoint can't
  // hammer Workers AI from a stuck button click.
  if (c.env.SCRAPE_CACHE) {
    const rlKey = `pf:rl:${email}:${id}`;
    const hit = await c.env.SCRAPE_CACHE.get(rlKey);
    if (hit) return c.json({ ok: false, error: "rate_limited", retry_in_seconds: 60 }, 429);
    await c.env.SCRAPE_CACHE.put(rlKey, "1", { expirationTtl: 60 });
  }

  // 7-day cap enforced even when dispatching to a workflow — Force
  // Refresh bypasses it but never the daily neuron cap.
  if (!body.force) {
    const { isWithinCooldown } = await import("../ai/profileFiller");
    const cool = await isWithinCooldown(c.env, id);
    if (cool.blocked) {
      return c.json({ ok: false, error: "cooldown_active", last_filled_at: cool.last_at, retry_with_force: true }, 429);
    }
  }

  if (c.env.WF_PROFILE_FILLER) {
    try {
      const wf = await c.env.WF_PROFILE_FILLER.create({ params: { entityId: id, force: !!body.force, triggeredBy: `manual:${email}` } });
      return c.json({ ok: true, dispatched: true, workflow_id: wf.id });
    } catch (e) {
      console.warn("WF_PROFILE_FILLER dispatch failed; falling back to inline", (e as Error).message);
    }
  }
  const { fillProfile } = await import("../ai/profileFiller");
  const r = await fillProfile(c.env, id, { force: !!body.force, triggeredBy: `manual:${email}` });
  return c.json(r);
});

// ---------------- POST /:id/refresh-government ----------------

profileRoute.post("/:id/refresh-government", async (c) => {
  const id = c.req.param("id");
  if (c.env.WF_REFRESH_GOVERNMENT) {
    const wf = await c.env.WF_REFRESH_GOVERNMENT.create({ params: { entityId: id } });
    return c.json({ ok: true, dispatched: true, workflow_id: wf.id });
  }
  const a = await refreshGovernmentAppointments(c.env, id);
  const d = await refreshDonations(c.env, id);
  return c.json({ ok: true, appointments: a, donations: d });
});

// ---------------- POST /:id/override ----------------

profileRoute.post("/:id/override", async (c) => {
  const id = c.req.param("id");
  const body = await c.req.json<{ field?: string; value?: unknown; note?: string }>().catch(() => ({} as { field?: string; value?: unknown; note?: string }));
  if (!body.field) return c.json({ error: "field_required" }, 400);
  const allowedFields = new Set([
    "primary_type", "primary_type_conf",
    "left_right", "lib_auth", "prog_cons", "glob_nat", "sec_rel",
  ]);
  if (!allowedFields.has(body.field)) return c.json({ error: "field_not_overridable", allowed: [...allowedFields] }, 400);
  await setManualOverride(c.env, id, body.field, body.value, c.var.email, body.note);
  // Append an entity_history row so the override is auditable.
  try {
    await c.env.DB.prepare(
      `INSERT INTO entity_history (id, entity_id, action, source, changed_at, new_value)
       VALUES (?, ?, 'classify_override', ?, ?, ?)`,
    ).bind(crypto.randomUUID(), id, c.var.email, new Date().toISOString(), JSON.stringify({ field: body.field, value: body.value, note: body.note ?? null })).run();
  } catch (e) {
    console.warn("override entity_history failed", (e as Error).message);
  }
  return c.json({ ok: true });
});

// ---------------- donations + appointments listings ----------------

profileRoute.get("/:id/donations", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "100"), 1), 500);
  const rows = await c.env.DB.prepare(
    `SELECT id, donor_name, recipient_name, recipient_party, recipient_kind, amount_usd, cycle, occurred_at, jurisdiction, source, source_url
       FROM political_donations WHERE entity_id = ? ORDER BY COALESCE(occurred_at, '') DESC LIMIT ?`,
  ).bind(id, limit).all();
  return c.json({ items: rows.results ?? [] });
});

profileRoute.post("/:id/donations", async (c) => {
  const id = c.req.param("id");
  type DonRowIn = { recipient_name: string; amount_usd?: number; cycle?: number; occurred_at?: string; recipient_party?: string; jurisdiction?: string; source_url?: string };
  const body = await c.req.json<{ rows?: DonRowIn[] }>().catch(() => ({} as { rows?: DonRowIn[] }));
  const rows = body.rows ?? [];
  if (!Array.isArray(rows) || !rows.length) return c.json({ error: "rows_required" }, 400);
  let inserted = 0;
  for (const r of rows.slice(0, 200)) {
    if (!r.recipient_name) continue;
    try {
      await c.env.DB.prepare(
        `INSERT INTO political_donations (id, entity_id, donor_name, recipient_name, recipient_party, amount_usd, cycle, occurred_at, jurisdiction, source, source_url)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'manual', ?)
         ON CONFLICT(entity_id, source, recipient_name, occurred_at, amount_usd) DO NOTHING`,
      ).bind(crypto.randomUUID(), id, r.recipient_name, r.recipient_party ?? null, r.amount_usd ?? null, r.cycle ?? null, r.occurred_at ?? null, r.jurisdiction ?? null, r.source_url ?? null).run();
      inserted++;
    } catch (e) { console.warn("manual donation insert failed", (e as Error).message); }
  }
  return c.json({ ok: true, inserted });
});

profileRoute.get("/:id/appointments", async (c) => {
  const id = c.req.param("id");
  const rows = await c.env.DB.prepare(
    `SELECT id, title, body, jurisdiction, party, seniority, start_date, end_date, is_current, source, source_url
       FROM government_appointments WHERE entity_id = ? ORDER BY is_current DESC, COALESCE(start_date, '') DESC LIMIT 200`,
  ).bind(id).all();
  return c.json({ items: rows.results ?? [] });
});

profileRoute.get("/:id/evidence", async (c) => {
  const id = c.req.param("id");
  const axis = c.req.query("axis") ?? undefined;
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
  const items = await getEvidence(c.env, id, axis, limit);
  return c.json({ items });
});
