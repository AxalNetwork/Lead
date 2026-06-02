// Task #31 — investor portfolio materializer.
//
// The investor profile page (routes/investors.ts GET /:id/profile) reads the
// portfolio from `investor_investments`, but nothing in the live pipeline
// writes that table any more — portfolio data is now collected into
// `firm_portfolio` (firm crawls) and `leads.companies_json` (angels). This
// module bridges that gap: it materializes `investor_investments` from those
// sources nightly (and on-demand per investor), creating the backing
// `companies` rows when a portfolio company isn't tracked yet.
//
// State-convergent: every run first deletes the rows it owns
// (source_provider LIKE 'derive:%') and re-derives, so removed source facts
// disappear on the next run. Manually-imported rows (other source_provider /
// NULL) are preserved.

import type { Env } from "../types";
import { canonicalDomain } from "../entities/normalize";
import { normalizeCompanyName } from "./deals/dedupe";

// Investor-specific titles only. Deliberately EXCLUDES generic executive
// tokens like "chief" (chief of staff / COO are not investing partners) so a
// firm's non-investing staff don't inherit the whole portfolio.
const PARTNER_RX = /\b(partner|gp|general partner|managing partner|managing director|md|principal|venture partner|investor|founding|founder)\b/i;
const INVESTOR_ROLE_RX = /\b(invest|angel|backer|\blp\b|limited partner|venture|advisor)\b/i;

// Hard ceilings so a single nightly tick stays well inside the Workers CPU
// budget even if the population grows. Partner fan-out is the main blow-up
// risk (firm portfolio × partners), so it gets its own per-firm cap.
const MAX_PARTNERS_PER_FIRM = 25;
const MAX_ROWS = 50_000;
const BATCH = 25; // D1 caps batched statements.

export interface MaterializeResult {
  companies_created: number;
  investments_written: number;
  firm_level: number;
  partner_level: number;
  angel_level: number;
}

interface FirmPortfolioRow {
  firm_id: number;
  company_name: string;
  company_domain: string | null;
  investment_year: number | null;
  stage: string | null;
  amount_usd: number | null;
  is_lead: number | null;
  source_url: string | null;
}

interface InvestmentInsert {
  investor_lead_id: string | null;
  firm_id: number | null;
  company_id: number;
  stage: string | null;
  amount_usd: number | null;
  is_lead: number;
  invested_at: string | null;
  source_url: string | null;
  source_provider: string;
}

type CompanyCache = Map<string, number>;

/**
 * Find or create a `companies` row for a portfolio company, returning its id.
 * Dedupe order: canonical domain → normalized-name slug → lowercased name.
 * Creating a row is intentional (the user opted to bridge crawled portfolio
 * data into the profile store); rows are tagged imported_from so they're
 * identifiable. Returns null only when both name and domain are unusable.
 */
export async function resolveCompanyId(
  env: Env,
  name: string | null,
  domain: string | null,
  cache: CompanyCache,
  sourceUrl: string | null,
  counters?: { created: number },
): Promise<number | null> {
  const cleanName = (name ?? "").trim();
  const cdomain = canonicalDomain(domain);
  const slug = normalizeCompanyName(cleanName);
  if (!cdomain && !slug && !cleanName) return null;

  const cacheKey = cdomain ? `d:${cdomain}` : slug ? `s:${slug}` : `n:${cleanName.toLowerCase()}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  let row: { id: number } | null = null;
  if (cdomain) {
    row = await env.DB.prepare("SELECT id FROM companies WHERE domain = ? LIMIT 1").bind(cdomain).first<{ id: number }>();
  }
  if (!row && slug) {
    row = await env.DB.prepare("SELECT id FROM companies WHERE slug = ? LIMIT 1").bind(slug).first<{ id: number }>();
  }
  if (!row && !slug && cleanName) {
    row = await env.DB.prepare("SELECT id FROM companies WHERE lower(name) = ? LIMIT 1").bind(cleanName.toLowerCase()).first<{ id: number }>();
  }

  let id: number;
  if (row) {
    id = row.id;
  } else {
    try {
      const ins = await env.DB
        .prepare(
          `INSERT INTO companies (name, slug, domain, source_url, imported_from, created_at)
           VALUES (?, ?, ?, ?, 'derive:portfolio', datetime('now'))`,
        )
        .bind(cleanName || (cdomain ?? slug), slug || null, cdomain, sourceUrl)
        .run();
      id = ins.meta.last_row_id as number;
      if (counters) counters.created += 1;
    } catch {
      // Lost a race on the UNIQUE(slug) — re-read by the strongest key.
      const re = cdomain
        ? await env.DB.prepare("SELECT id FROM companies WHERE domain = ? LIMIT 1").bind(cdomain).first<{ id: number }>()
        : await env.DB.prepare("SELECT id FROM companies WHERE slug = ? LIMIT 1").bind(slug).first<{ id: number }>();
      if (!re) return null;
      id = re.id;
    }
  }
  cache.set(cacheKey, id);
  return id;
}

async function flush(env: Env, rows: InvestmentInsert[]): Promise<number> {
  if (!rows.length) return 0;
  const stmt = env.DB.prepare(
    `INSERT INTO investor_investments
       (investor_lead_id, firm_id, company_id, stage, amount_usd, is_lead, invested_at, source_url, source_provider, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  let wrote = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    await env.DB.batch(
      slice.map((r) =>
        stmt.bind(
          r.investor_lead_id, r.firm_id, r.company_id, r.stage,
          r.amount_usd, r.is_lead, r.invested_at, r.source_url, r.source_provider,
        ),
      ),
    );
    wrote += slice.length;
  }
  return wrote;
}

function investedAt(year: number | null): string | null {
  return year && Number.isFinite(year) ? `${year}-01-01` : null;
}

interface CompanyJsonEntry {
  name?: string;
  domain?: string;
  role?: string;
  founder?: boolean;
  investor?: boolean;
  investment?: boolean;
  stage?: string;
  amount_usd?: number;
  year?: number;
}

/**
 * Materialize investor_investments. When opts.investorLeadId is given only
 * that investor's derived rows are rebuilt (on-demand enrich path); otherwise
 * the whole population is rebuilt (nightly sweep).
 */
export async function materializeInvestorPortfolio(
  env: Env,
  opts: { investorLeadId?: string; maxRows?: number } = {},
): Promise<MaterializeResult> {
  const single = opts.investorLeadId ?? null;
  const result: MaterializeResult = {
    companies_created: 0, investments_written: 0, firm_level: 0, partner_level: 0, angel_level: 0,
  };
  const counters = { created: 0 };
  const companyCache: CompanyCache = new Map();
  const pending: InvestmentInsert[] = [];
  const maxRows = opts.maxRows ?? MAX_ROWS;
  let total = 0;
  const atCap = () => total >= maxRows;
  const push = (r: InvestmentInsert) => {
    if (atCap()) return;
    pending.push(r); total += 1;
  };

  // ---- firm partners: firm_id -> [current partner lead ids] -------------
  // Single mode: only the firms this investor is a current partner at.
  const partnersByFirm = new Map<number, string[]>();
  const fpSql = single
    ? "SELECT firm_id, lead_id, role FROM firm_people WHERE ended_at IS NULL AND lead_id = ?"
    : "SELECT firm_id, lead_id, role FROM firm_people WHERE ended_at IS NULL";
  const fpRows = single
    ? await env.DB.prepare(fpSql).bind(single).all<{ firm_id: number; lead_id: string; role: string | null }>()
    : await env.DB.prepare(fpSql).all<{ firm_id: number; lead_id: string; role: string | null }>();
  for (const r of fpRows.results ?? []) {
    if (r.role && !PARTNER_RX.test(r.role)) continue;
    const arr = partnersByFirm.get(r.firm_id) ?? [];
    if (arr.length < MAX_PARTNERS_PER_FIRM) arr.push(r.lead_id);
    partnersByFirm.set(r.firm_id, arr);
  }

  // ---- firm_portfolio → firm-level + partner-level investments ----------
  // Single mode restricts to the firms the investor partners at; firm-level
  // (investor_lead_id NULL) rows are only emitted on the full sweep.
  const firmIds = [...partnersByFirm.keys()];
  let portRows: FirmPortfolioRow[] = [];
  if (single) {
    if (firmIds.length) {
      const ph = firmIds.map(() => "?").join(",");
      const r = await env.DB.prepare(
        `SELECT firm_id, company_name, company_domain, investment_year, stage, amount_usd, is_lead, source_url
           FROM firm_portfolio WHERE firm_id IN (${ph})`,
      ).bind(...firmIds).all<FirmPortfolioRow>();
      portRows = r.results ?? [];
    }
  } else {
    const r = await env.DB.prepare(
      `SELECT firm_id, company_name, company_domain, investment_year, stage, amount_usd, is_lead, source_url
         FROM firm_portfolio`,
    ).all<FirmPortfolioRow>();
    portRows = r.results ?? [];
  }

  for (const p of portRows) {
    if (atCap()) break; // stop before resolving so we don't create orphan companies past the cap
    if (!p.company_name) continue;
    const companyId = await resolveCompanyId(env, p.company_name, p.company_domain, companyCache, p.source_url, counters);
    if (!companyId) continue;
    const base = {
      company_id: companyId,
      stage: p.stage ?? null,
      amount_usd: p.amount_usd ?? null,
      is_lead: p.is_lead ? 1 : 0,
      invested_at: investedAt(p.investment_year),
      source_url: p.source_url ?? null,
      source_provider: "derive:firm_portfolio",
    };
    if (!single) {
      push({ investor_lead_id: null, firm_id: p.firm_id, ...base });
      result.firm_level += 1;
    }
    for (const leadId of partnersByFirm.get(p.firm_id) ?? []) {
      push({ investor_lead_id: leadId, firm_id: p.firm_id, ...base });
      result.partner_level += 1;
    }
  }

  // ---- leads.companies_json → angel / personal investments --------------
  const leadSql = single
    ? "SELECT id, companies_json FROM leads WHERE id = ? AND companies_json IS NOT NULL"
    : "SELECT id, companies_json FROM leads WHERE companies_json IS NOT NULL AND merged_into IS NULL";
  const leadRows = single
    ? await env.DB.prepare(leadSql).bind(single).all<{ id: string; companies_json: string }>()
    : await env.DB.prepare(leadSql).all<{ id: string; companies_json: string }>();
  for (const row of leadRows.results ?? []) {
    let arr: CompanyJsonEntry[] = [];
    try { arr = JSON.parse(row.companies_json); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    if (atCap()) break;
    for (const c of arr) {
      if (atCap()) break; // stop before resolving so we don't create orphan companies past the cap
      if (!c || !c.name) continue;
      const isInvestment = c.investor === true || c.investment === true || (typeof c.role === "string" && INVESTOR_ROLE_RX.test(c.role));
      if (!isInvestment) continue;
      const companyId = await resolveCompanyId(env, c.name, c.domain ?? null, companyCache, null, counters);
      if (!companyId) continue;
      push({
        investor_lead_id: row.id, firm_id: null, company_id: companyId,
        stage: c.stage ?? null, amount_usd: typeof c.amount_usd === "number" ? c.amount_usd : null,
        is_lead: 0, invested_at: investedAt(c.year ?? null), source_url: null,
        source_provider: "derive:leads.companies_json",
      });
      result.angel_level += 1;
    }
  }

  // State-convergent replace of the rows this module owns. Done AFTER all
  // resolution so the delete→insert empty-window is as small as possible: a
  // mid-run failure during resolution leaves the prior derived rows intact.
  if (single) {
    await env.DB.prepare(
      "DELETE FROM investor_investments WHERE investor_lead_id = ? AND source_provider LIKE 'derive:%'",
    ).bind(single).run();
  } else {
    await env.DB.prepare("DELETE FROM investor_investments WHERE source_provider LIKE 'derive:%'").run();
  }

  result.investments_written = await flush(env, pending);
  result.companies_created = counters.created;
  return result;
}
