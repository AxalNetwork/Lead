// Nightly relationship derivation (Task #21).
// Re-emits all derivable relationship kinds from source tables.
// Idempotent via the relationships UNIQUE(src,dst,kind,source) index +
// INSERT OR REPLACE. Designed to run under one minute on a few-thousand-
// firm dataset; we batch upserts to keep round-trips low.

import type { Env } from "../../types";

interface UpsertRow {
  src: number; dst: number; kind: string; source: string;
  strength?: number; started_at?: string | null; ended_at?: string | null;
  evidence_url?: string | null; meta?: unknown;
}

interface DeriveResult {
  entities_upserted: number;
  edges_upserted: number;
  by_kind: Record<string, number>;
}

const PARTNER_RX = /\b(partner|gp|principal|managing director|md)\b/i;

/** Idempotently get-or-create an entity row, returning its id. */
async function ensureEntity(env: Env, kind: string, ref_table: string | null, ref_id: string | null, name: string, meta?: unknown): Promise<number> {
  if (ref_table && ref_id) {
    const existing = await env.DB
      .prepare("SELECT id FROM entities WHERE ref_table = ? AND ref_id = ?")
      .bind(ref_table, ref_id).first<{ id: number }>();
    if (existing) return existing.id;
  }
  const r = await env.DB
    .prepare("INSERT INTO entities (kind, ref_table, ref_id, name, meta_json) VALUES (?,?,?,?,?)")
    .bind(kind, ref_table, ref_id, name, meta ? JSON.stringify(meta) : null).run();
  return r.meta.last_row_id as number;
}

/**
 * Backfill `entities` so every row in `leads`, `firms`, and the unique
 * `firm_portfolio.company_name` set has an entity. Uses INSERT OR IGNORE
 * against the (ref_table, ref_id) unique index so re-runs are cheap.
 */
async function backfillEntities(env: Env): Promise<number> {
  let wrote = 0;
  // Leads → person entities. We use coalesce(name, email, id) so the entity
  // always has a label even if the lead is sparsely populated.
  const leads = await env.DB
    .prepare("SELECT id, COALESCE(name, email, 'Lead ' || substr(id,1,8)) AS name FROM leads WHERE merged_into IS NULL")
    .all<{ id: string; name: string }>();
  for (const l of leads.results ?? []) {
    const r = await env.DB
      .prepare("INSERT OR IGNORE INTO entities (kind, ref_table, ref_id, name) VALUES ('person','leads',?,?)")
      .bind(l.id, l.name).run();
    if (r.meta.changes) wrote++;
  }
  // Firms → firm entities.
  const firms = await env.DB
    .prepare("SELECT id, name FROM firms")
    .all<{ id: number; name: string }>();
  for (const f of firms.results ?? []) {
    const r = await env.DB
      .prepare("INSERT OR IGNORE INTO entities (kind, ref_table, ref_id, name) VALUES ('firm','firms',?,?)")
      .bind(String(f.id), f.name).run();
    if (r.meta.changes) wrote++;
  }
  // Portfolio companies → company entities. Company "id" is the lowercased
  // domain when present, else a slugified name. This keeps two firms
  // pointing to the same company resolving to the same entity.
  const companies = await env.DB
    .prepare(`SELECT DISTINCT
                COALESCE(LOWER(NULLIF(company_domain, '')), LOWER(REPLACE(company_name, ' ', '_'))) AS ref_id,
                MAX(company_name) AS name
              FROM firm_portfolio
              WHERE company_name IS NOT NULL AND company_name != ''
              GROUP BY ref_id`)
    .all<{ ref_id: string; name: string }>();
  for (const co of companies.results ?? []) {
    if (!co.ref_id) continue;
    const r = await env.DB
      .prepare("INSERT OR IGNORE INTO entities (kind, ref_table, ref_id, name) VALUES ('company','companies',?,?)")
      .bind(co.ref_id, co.name).run();
    if (r.meta.changes) wrote++;
  }
  return wrote;
}

/** Upsert in batches of 25 — D1 limits batched statements. */
async function upsertEdges(env: Env, rows: UpsertRow[]): Promise<number> {
  if (!rows.length) return 0;
  let wrote = 0;
  for (let i = 0; i < rows.length; i += 25) {
    const slice = rows.slice(i, i + 25);
    const stmts = slice.map((e) =>
      env.DB.prepare(
        `INSERT OR REPLACE INTO relationships
           (src, dst, kind, source, strength, started_at, ended_at, evidence_url, meta_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`,
      ).bind(
        e.src, e.dst, e.kind, e.source,
        e.strength ?? 1.0,
        e.started_at ?? null, e.ended_at ?? null,
        e.evidence_url ?? null,
        e.meta ? JSON.stringify(e.meta) : null,
      ),
    );
    await env.DB.batch(stmts);
    wrote += slice.length;
  }
  return wrote;
}

export async function runRelationshipDerivation(env: Env): Promise<DeriveResult> {
  const result: DeriveResult = { entities_upserted: 0, edges_upserted: 0, by_kind: {} };
  result.entities_upserted = await backfillEntities(env);

  // State-convergent derivation: clear all prior derive:* edges before
  // re-emitting from current source truth. Manually-curated rows
  // (source NOT LIKE 'derive:%') are preserved. This guarantees that
  // removed source facts (deleted firm_people rows, edited
  // companies_json, dropped portfolio entries, etc.) disappear from
  // the relationship graph on the next nightly run.
  await env.DB.prepare("DELETE FROM relationships WHERE source LIKE 'derive:%'").run();

  // Cache entity ids by (ref_table, ref_id) once — saves N round-trips.
  const allEntities = await env.DB
    .prepare("SELECT id, ref_table, ref_id FROM entities WHERE ref_table IS NOT NULL")
    .all<{ id: number; ref_table: string; ref_id: string }>();
  const entityIx = new Map<string, number>();
  for (const e of allEntities.results ?? []) entityIx.set(e.ref_table + ":" + e.ref_id, e.id);
  const lookup = (table: string, id: string | number) => entityIx.get(table + ":" + String(id));

  // 1) works_at / was_at / partner_at — from firm_people. ended_at NOT NULL
  // ⇒ historical, otherwise current. partner detected by role regex.
  const fp = await env.DB
    .prepare("SELECT firm_id, lead_id, role, started_at, ended_at, source_url FROM firm_people")
    .all<{ firm_id: number; lead_id: string; role: string | null; started_at: string | null; ended_at: string | null; source_url: string | null }>();
  const worksAt: UpsertRow[] = [];
  for (const r of fp.results ?? []) {
    const personE = lookup("leads", r.lead_id);
    const firmE = lookup("firms", String(r.firm_id));
    if (!personE || !firmE) continue;
    const kind = r.ended_at ? "was_at" : "works_at";
    worksAt.push({
      src: personE, dst: firmE, kind, source: "derive:firm_people",
      started_at: r.started_at, ended_at: r.ended_at, evidence_url: r.source_url,
    });
    if (r.role && PARTNER_RX.test(r.role)) {
      worksAt.push({
        src: personE, dst: firmE, kind: "partner_at", source: "derive:firm_people",
        started_at: r.started_at, ended_at: r.ended_at, evidence_url: r.source_url,
      });
    }
  }
  result.by_kind.works_at_etc = await upsertEdges(env, worksAt);

  // 2) invested_in / led_round_in — from firm_portfolio.
  const port = await env.DB
    .prepare("SELECT firm_id, company_name, company_domain, investment_year, is_lead, source_url FROM firm_portfolio")
    .all<{ firm_id: number; company_name: string; company_domain: string | null; investment_year: number | null; is_lead: number; source_url: string | null }>();
  const investEdges: UpsertRow[] = [];
  // Group by company so co_invested_with can be derived in the same pass.
  const byCompany = new Map<string, Array<{ firmE: number; year: number | null }>>();
  for (const p of port.results ?? []) {
    const coKey = (p.company_domain ? p.company_domain.toLowerCase() : p.company_name.toLowerCase().replace(/ /g, "_"));
    const firmE = lookup("firms", String(p.firm_id));
    const compE = lookup("companies", coKey);
    if (!firmE || !compE) continue;
    investEdges.push({
      src: firmE, dst: compE, kind: "invested_in", source: "derive:firm_portfolio",
      started_at: p.investment_year ? String(p.investment_year) + "-01-01" : null,
      evidence_url: p.source_url,
    });
    if (p.is_lead) {
      investEdges.push({
        src: firmE, dst: compE, kind: "led_round_in", source: "derive:firm_portfolio",
        started_at: p.investment_year ? String(p.investment_year) + "-01-01" : null,
        evidence_url: p.source_url,
      });
    }
    if (!byCompany.has(coKey)) byCompany.set(coKey, []);
    byCompany.get(coKey)!.push({ firmE, year: p.investment_year });
  }
  result.by_kind.invested_in = await upsertEdges(env, investEdges);

  // 3) co_invested_with — every pair of firms that backed the same company in
  // the same investment_year (or with unknown year). The unique key is
  // (src,dst,kind,source); we encode the company key + year into `source`
  // so each shared deal becomes its own row and COUNT(*) on /coinvestors
  // returns the true overlap count.
  const coInvest: UpsertRow[] = [];
  for (const [coKey, pairs] of byCompany.entries()) {
    for (let i = 0; i < pairs.length; i++) {
      for (let j = i + 1; j < pairs.length; j++) {
        const a = pairs[i], b = pairs[j];
        if (a.firmE === b.firmE) continue;
        if (a.year && b.year && a.year !== b.year) continue;
        const yr = a.year || b.year || 0;
        const src = `derive:firm_portfolio:${coKey}:${yr}`;
        coInvest.push({ src: a.firmE, dst: b.firmE, kind: "co_invested_with", source: src, strength: 1, meta: { company: coKey, year: yr } });
        coInvest.push({ src: b.firmE, dst: a.firmE, kind: "co_invested_with", source: src, strength: 1, meta: { company: coKey, year: yr } });
      }
    }
  }
  result.by_kind.co_invested_with = await upsertEdges(env, coInvest);

  // 4) founded — leads.companies_json contains {name, role, founder?}.
  // We treat any entry with role matching /found|ceo|co-?founder/i as a
  // founded edge to the company entity (created if needed).
  const founders = await env.DB
    .prepare("SELECT id, companies_json FROM leads WHERE companies_json IS NOT NULL AND merged_into IS NULL")
    .all<{ id: string; companies_json: string }>();
  const foundEdges: UpsertRow[] = [];
  for (const row of founders.results ?? []) {
    let arr: Array<{ name?: string; domain?: string; role?: string; founder?: boolean }> = [];
    try { arr = JSON.parse(row.companies_json); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    const personE = lookup("leads", row.id);
    if (!personE) continue;
    for (const c of arr) {
      const isFounder = c.founder === true || (c.role && /found|ceo|co-?founder/i.test(c.role));
      if (!isFounder || !c.name) continue;
      const coKey = (c.domain ? c.domain.toLowerCase() : c.name.toLowerCase().replace(/ /g, "_"));
      let compE = lookup("companies", coKey);
      if (!compE) {
        compE = await ensureEntity(env, "company", "companies", coKey, c.name);
        entityIx.set("companies:" + coKey, compE);
      }
      foundEdges.push({ src: personE, dst: compE, kind: "founded", source: "derive:leads.companies_json" });
    }
  }
  result.by_kind.founded = await upsertEdges(env, foundEdges);

  // 5) colleague_of — pairs of people sharing a firm with overlapping date
  // ranges. Any null end means "still there", any null start means "before
  // recorded history" — both treated as open-ended for overlap purposes.
  const colleagueEdges: UpsertRow[] = [];
  // Group firm_people rows by firm_id once.
  const byFirm = new Map<number, Array<{ leadId: string; start: string | null; end: string | null }>>();
  for (const r of fp.results ?? []) {
    if (!byFirm.has(r.firm_id)) byFirm.set(r.firm_id, []);
    byFirm.get(r.firm_id)!.push({ leadId: r.lead_id, start: r.started_at, end: r.ended_at });
  }
  function overlaps(a: { start: string | null; end: string | null }, b: { start: string | null; end: string | null }): boolean {
    if (a.end && b.start && a.end < b.start) return false;
    if (b.end && a.start && b.end < a.start) return false;
    return true;
  }
  for (const [, members] of byFirm.entries()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        if (members[i].leadId === members[j].leadId) continue;
        if (!overlaps(members[i], members[j])) continue;
        const a = lookup("leads", members[i].leadId);
        const b = lookup("leads", members[j].leadId);
        if (!a || !b) continue;
        colleagueEdges.push({ src: a, dst: b, kind: "colleague_of", source: "derive:firm_people" });
        colleagueEdges.push({ src: b, dst: a, kind: "colleague_of", source: "derive:firm_people" });
      }
    }
  }
  result.by_kind.colleague_of = await upsertEdges(env, colleagueEdges);

  // 6) school_with — pairs of people with overlapping years at the same
  // institution. Source: leads.meta_json.education[] (when present).
  // Conservative: requires both name + a `school` field, year overlap is
  // optional (if any side missing years we still emit the edge).
  const eduRows = await env.DB
    .prepare("SELECT id, meta_json FROM leads WHERE meta_json LIKE '%education%' AND merged_into IS NULL LIMIT 5000")
    .all<{ id: string; meta_json: string }>();
  // school -> [ {leadE, start, end} ]
  const bySchool = new Map<string, Array<{ leadE: number; start: number | null; end: number | null }>>();
  for (const row of eduRows.results ?? []) {
    let meta: { education?: Array<{ school?: string; start_year?: number; end_year?: number }> } = {};
    try { meta = JSON.parse(row.meta_json); } catch { continue; }
    if (!meta.education || !Array.isArray(meta.education)) continue;
    const personE = lookup("leads", row.id);
    if (!personE) continue;
    for (const e of meta.education) {
      if (!e.school) continue;
      const key = e.school.toLowerCase().trim();
      if (!bySchool.has(key)) bySchool.set(key, []);
      bySchool.get(key)!.push({ leadE: personE, start: e.start_year ?? null, end: e.end_year ?? null });
    }
  }
  const schoolEdges: UpsertRow[] = [];
  for (const [, members] of bySchool.entries()) {
    for (let i = 0; i < members.length; i++) {
      for (let j = i + 1; j < members.length; j++) {
        const a = members[i], b = members[j];
        if (a.leadE === b.leadE) continue;
        // Year overlap if both sides have years, otherwise allow.
        if (a.end && b.start && a.end < b.start) continue;
        if (b.end && a.start && b.end < a.start) continue;
        schoolEdges.push({ src: a.leadE, dst: b.leadE, kind: "school_with", source: "derive:leads.meta.education" });
        schoolEdges.push({ src: b.leadE, dst: a.leadE, kind: "school_with", source: "derive:leads.meta.education" });
      }
    }
  }
  result.by_kind.school_with = await upsertEdges(env, schoolEdges);

  // 7) mentions — lightweight bio scan: emit person→firm `mentions` edges
  // when a firm name (length ≥ 4 to avoid noise) appears verbatim in a
  // lead's bio and the lead doesn't already have a works_at edge to that
  // firm (which would dominate). Bounded to the first 5000 leads with bio.
  const bios = await env.DB
    .prepare("SELECT id, bio FROM leads WHERE bio IS NOT NULL AND length(bio) > 20 AND merged_into IS NULL LIMIT 5000")
    .all<{ id: string; bio: string }>();
  // Build a name → firm entity index, lowercased, restricted to non-trivial
  // names. Refetch firms here since `backfillEntities`'s local var isn't
  // visible at this scope.
  const firmsForMentions = await env.DB
    .prepare("SELECT id, name FROM firms WHERE name IS NOT NULL AND length(name) >= 4")
    .all<{ id: number; name: string }>();
  const firmNameIx: Array<{ name: string; entE: number }> = [];
  for (const f of firmsForMentions.results ?? []) {
    const e = lookup("firms", String(f.id)); if (!e) continue;
    firmNameIx.push({ name: f.name.toLowerCase(), entE: e });
  }
  // Aggregate occurrence counts per (person, firm) so strength reflects how
  // often a firm is mentioned in a person's bio (case-insensitive substring
  // count). One row per pair → strength = count, with a stable source so
  // re-runs upsert in place rather than appending duplicates.
  const mentionAgg = new Map<string, { src: number; dst: number; count: number }>();
  for (const row of bios.results ?? []) {
    const personE = lookup("leads", row.id); if (!personE) continue;
    const lower = row.bio.toLowerCase();
    for (const f of firmNameIx) {
      let pos = 0, count = 0;
      while ((pos = lower.indexOf(f.name, pos)) !== -1) { count++; pos += f.name.length; if (count >= 8) break; }
      if (!count) continue;
      const k = personE + ":" + f.entE;
      const prev = mentionAgg.get(k);
      if (prev) prev.count += count;
      else mentionAgg.set(k, { src: personE, dst: f.entE, count });
    }
  }
  // Co-occurrence on the same scraped page: any (lead_history,firm_history)
  // row pair sharing an evidence_url indicates that page mentioned both
  // entities. Strength = number of distinct shared pages.
  const coPage = await env.DB.prepare(
    `SELECT lh.lead_id AS lead_id, fh.firm_id AS firm_id, COUNT(DISTINCT lh.evidence_url) AS pages
     FROM lead_history lh
     JOIN firm_history fh ON fh.evidence_url = lh.evidence_url
     WHERE lh.evidence_url IS NOT NULL AND lh.evidence_url != ''
     GROUP BY lh.lead_id, fh.firm_id`,
  ).all<{ lead_id: string; firm_id: number; pages: number }>();
  for (const row of coPage.results ?? []) {
    const personE = lookup("leads", row.lead_id); if (!personE) continue;
    const firmE = lookup("firms", String(row.firm_id)); if (!firmE) continue;
    const k = personE + ":" + firmE;
    const prev = mentionAgg.get(k);
    if (prev) prev.count += row.pages;
    else mentionAgg.set(k, { src: personE, dst: firmE, count: row.pages });
  }
  const mentionEdges: UpsertRow[] = [];
  for (const m of mentionAgg.values()) {
    mentionEdges.push({ src: m.src, dst: m.dst, kind: "mentions", source: "derive:co_page:agg", strength: m.count });
  }
  result.by_kind.mentions = await upsertEdges(env, mentionEdges);

  // was_at from enrichment history: lead_history rows where the
  // companies_json field changed and a previously listed company name no
  // longer appears in the new value imply an ended employment.
  const histEmpl = await env.DB.prepare(
    `SELECT lead_id, old_value, new_value, evidence_url, changed_at
     FROM lead_history
     WHERE field = 'companies_json' AND old_value IS NOT NULL`,
  ).all<{ lead_id: string; old_value: string; new_value: string | null; evidence_url: string | null; changed_at: string }>();
  const wasAtEdges: UpsertRow[] = [];
  function namesFromCompaniesJson(s: string | null): string[] {
    if (!s) return [];
    try {
      const arr = JSON.parse(s);
      if (!Array.isArray(arr)) return [];
      return arr.map((c) => (c && c.name ? String(c.name).toLowerCase() : "")).filter(Boolean);
    } catch { return []; }
  }
  // Reverse-lookup from lowercase firm name → entity id.
  const firmByName = new Map<string, number>();
  for (const f of firmsForMentions.results ?? []) {
    const e = lookup("firms", String(f.id)); if (e) firmByName.set(f.name.toLowerCase(), e);
  }
  for (const row of histEmpl.results ?? []) {
    const personE = lookup("leads", row.lead_id); if (!personE) continue;
    const oldNames = new Set(namesFromCompaniesJson(row.old_value));
    const newNames = new Set(namesFromCompaniesJson(row.new_value));
    for (const n of oldNames) {
      if (newNames.has(n)) continue;
      const firmE = firmByName.get(n); if (!firmE) continue;
      wasAtEdges.push({
        src: personE, dst: firmE, kind: "was_at",
        source: "derive:lead_history.companies_json",
        ended_at: row.changed_at, evidence_url: row.evidence_url ?? null,
      });
    }
  }
  result.by_kind.was_at_history = await upsertEdges(env, wasAtEdges);

  result.edges_upserted =
    Object.values(result.by_kind).reduce((s, n) => s + n, 0);
  return result;
}
