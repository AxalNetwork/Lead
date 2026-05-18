// Task #4 saved-alert trigger: "Form D filing for company in my pipeline".
// Source-driven evaluator over sec_filings.
//
//   { form_types?: string[], issuer_entity_ids?: string[] }
//
// "Form D in pipeline" → form_types=["D"],
//                        issuer_entity_ids=[<watchlist member ids>]
//
// `issuer_entity_ids` is resolved by the caller from
// watchlist_members when the rule is watchlist-scoped (see
// monitoring/runner.ts source-driven path).

import type { EvaluatorFn } from "../types";

interface Cfg {
  form_types?: string[];
  issuer_entity_ids?: string[];
}

export const evalSecFilingMatch: EvaluatorFn = async (ctx) => {
  const cfg = (ctx.ruleConfig ?? {}) as Cfg;
  const since = ctx.sinceWatermark ?? null;
  const wheres: string[] = [];
  const binds: unknown[] = [];
  if (Array.isArray(cfg.form_types) && cfg.form_types.length) {
    wheres.push(`form_type IN (${cfg.form_types.map(() => "?").join(",")})`);
    binds.push(...cfg.form_types);
  }
  // Issuer matching: if a watchlist is attached, pass the entity_id
  // directly (single-entity rule) OR rely on issuer_entity_ids in cfg.
  const issuers = Array.isArray(cfg.issuer_entity_ids) ? cfg.issuer_entity_ids.filter((s) => typeof s === "string") : [];
  if (ctx.entityId && !issuers.length) {
    wheres.push("entity_id = ?"); binds.push(ctx.entityId);
  } else if (issuers.length) {
    wheres.push(`entity_id IN (${issuers.map(() => "?").join(",")})`);
    binds.push(...issuers);
  }
  if (since) { wheres.push("datetime(filed_at) > datetime(?)"); binds.push(since); }
  if (!wheres.length) return null;
  let rows;
  try {
    rows = await ctx.env.DB.prepare(
      `SELECT accession_no, cik, form_type, filer_name, filed_at, filing_url, entity_id
         FROM sec_filings WHERE ${wheres.join(" AND ")}
         ORDER BY filed_at DESC LIMIT 10`,
    ).bind(...binds).all<{
      accession_no: string; cik: string; form_type: string;
      filer_name: string | null; filed_at: string; filing_url: string;
      entity_id: string | null;
    }>();
  } catch { return null; }
  const items = rows.results ?? [];
  if (!items.length) return null;
  const top = items[0];
  return {
    dedupe_key: top.accession_no,
    title: `SEC ${top.form_type}: ${top.filer_name ?? top.cik}`,
    body: items.slice(0, 5).map((i) =>
      `• Form ${i.form_type} — ${i.filer_name ?? i.cik} (${i.filed_at})`,
    ).join("\n"),
    diff: [],
    payload: { items, config: cfg, since },
  };
};
