// Task #4: portfolio_of edges from firm_portfolio. The legacy firms
// schema uses INTEGER firm_id, so we join to the entity_legacy_map
// (firms ↔ u_entities). Companies are resolved by company_domain
// (preferred) then company_name; unresolved rows are dropped.

import type { Env } from "../../../types";
import type { EdgeProposal, ExtractOpts, ExtractResult } from "../types";
import { safeAll } from "../_safeQuery";
import { resolveEntityId } from "../resolve";

interface Row {
  firm_id: number; firm_entity_id: string | null;
  company_name: string; company_domain: string | null; company_url: string | null;
  investment_year: number | null;
}

export const NAME = "portfolioFromFirmSite";

export async function extract(env: Env, opts: ExtractOpts = {}): Promise<ExtractResult> {
  const limit = opts.limit ?? 5000;
  const binds: unknown[] = [];
  let extra = "";
  if (opts.entityId) {
    // Filter to the firm matching this entity (if mapped).
    extra = ` AND (m.entity_id = ?)`;
    binds.push(opts.entityId);
  }
  const rows = await safeAll<Row>(
    env,
    `SELECT fp.firm_id, m.entity_id AS firm_entity_id, fp.company_name, fp.company_domain,
            fp.company_url, fp.investment_year
       FROM firm_portfolio fp
       LEFT JOIN entity_legacy_map m ON m.legacy_table = 'firms' AND m.legacy_id = CAST(fp.firm_id AS TEXT)
      WHERE 1=1 ${extra}
      LIMIT ${limit}`,
    ...binds,
  );
  const proposals: EdgeProposal[] = [];
  let unresolved = 0;
  for (const r of rows) {
    if (!r.firm_entity_id) { unresolved += 1; continue; }
    let company: string | null = null;
    if (r.company_domain) company = await resolveEntityId(env, r.company_domain, "org");
    if (!company) company = await resolveEntityId(env, r.company_name, "org");
    if (!company) { unresolved += 1; continue; }
    proposals.push({
      src_entity_id: r.firm_entity_id, dst_entity_id: company, kind: "portfolio_of",
      source: "firm_site",
      valid_from: r.investment_year != null ? `${r.investment_year}-01-01` : null,
      evidence_url: r.company_url ?? null, backing_fact_ids: [],
    });
  }
  return { proposals, unresolved_count: unresolved, scanned: rows.length };
}
