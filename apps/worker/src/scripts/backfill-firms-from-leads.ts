// One-shot backfill: turn existing leads.org values into firm rows and link
// each lead via firm_people. Idempotent — safe to call multiple times because
// it slug-matches existing firms before inserting and uses the
// (firm_id, lead_id, role) UNIQUE constraint on firm_people.
//
// Invoked via `POST /api/firms/_backfill` (registered in src/routes/firms.ts).

import type { Env } from "../types";

interface LeadRow {
  id: string;
  org: string | null;
  source_domain: string | null;
  title: string | null;
  persona_role: string | null;
  seniority: string | null;
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function inferRole(seniority: string | null, persona: string | null, title: string | null): string | null {
  const t = `${seniority ?? ""} ${persona ?? ""} ${title ?? ""}`.toLowerCase();
  if (/general[_\s-]?partner|managing[_\s-]?partner|gp\b/.test(t)) return "general_partner";
  if (/managing[_\s-]?director/.test(t)) return "managing_partner";
  if (/principal/.test(t)) return "principal";
  if (/venture[_\s-]?partner/.test(t)) return "venture_partner";
  if (/operating[_\s-]?partner/.test(t)) return "operating_partner";
  if (/associate/.test(t)) return "associate";
  if (/analyst/.test(t)) return "analyst";
  if (/founder/.test(t)) return "founder";
  if (/^ceo\b|chief executive/.test(t)) return "ceo";
  if (/partner/.test(t)) return "general_partner";
  return null;
}

export interface BackfillSummary {
  leads_scanned: number;
  firms_created: number;
  firms_existing: number;
  links_created: number;
  links_existing: number;
}

export async function backfillFirmsFromLeads(env: Env): Promise<BackfillSummary> {
  const summary: BackfillSummary = {
    leads_scanned: 0,
    firms_created: 0,
    firms_existing: 0,
    links_created: 0,
    links_existing: 0,
  };

  const leads = await env.DB
    .prepare(
      `SELECT id, org, source_domain, title, persona_role, seniority
       FROM leads
       WHERE org IS NOT NULL AND TRIM(org) <> ''`,
    )
    .all<LeadRow>();
  const rows = leads.results ?? [];
  summary.leads_scanned = rows.length;

  // Group by (lower(org), source_domain).
  const groups = new Map<string, { name: string; domain: string | null; leads: LeadRow[] }>();
  for (const lead of rows) {
    const name = (lead.org ?? "").trim();
    if (!name) continue;
    const domain = (lead.source_domain ?? "").trim().toLowerCase() || null;
    const key = `${name.toLowerCase()}::${domain ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { name, domain, leads: [] };
      groups.set(key, g);
    }
    g.leads.push(lead);
  }

  for (const g of groups.values()) {
    const slug = slugify(g.name);
    let firmId: number | null = null;

    const existing = await env.DB
      .prepare("SELECT id FROM firms WHERE slug = ? LIMIT 1")
      .bind(slug)
      .first<{ id: number }>();
    if (existing) {
      firmId = existing.id;
      summary.firms_existing += 1;
    } else {
      try {
        const ins = await env.DB
          .prepare(
            `INSERT INTO firms (name, slug, domain, source_url, imported_from, status)
             VALUES (?, ?, ?, ?, 'backfill_leads', 'new')`,
          )
          .bind(g.name, slug, g.domain, g.domain ? `https://${g.domain}` : null)
          .run();
        firmId = (ins.meta.last_row_id as number) ?? null;
        summary.firms_created += 1;
      } catch {
        // Slug race: re-read.
        const re = await env.DB
          .prepare("SELECT id FROM firms WHERE slug = ? LIMIT 1")
          .bind(slug)
          .first<{ id: number }>();
        if (re) {
          firmId = re.id;
          summary.firms_existing += 1;
        }
      }
    }
    if (firmId == null) continue;

    for (const lead of g.leads) {
      const role = inferRole(lead.seniority, lead.persona_role, lead.title);
      try {
        const r = await env.DB
          .prepare(
            `INSERT INTO firm_people (firm_id, lead_id, role) VALUES (?, ?, ?)`,
          )
          .bind(firmId, lead.id, role)
          .run();
        if ((r.meta.changes ?? 0) > 0) summary.links_created += 1;
      } catch (e) {
        const msg = (e as Error).message ?? "";
        if (msg.includes("UNIQUE")) summary.links_existing += 1;
      }
    }
  }

  return summary;
}
