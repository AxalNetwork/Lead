// Task #1: SEC EDGAR persist layer.
//
// Consumes a ParsedFiling from the adapter and writes it through:
//   1. `insertFact` — canonical entity-fact write path (per replit.md)
//   2. `sec_*` raw tables — typed per-form storage for downstream queries
//   3. `sec_filings` — dedup + provenance ledger keyed on accession_no
//
// All writes are idempotent on accession_no (PRIMARY KEY / UNIQUE).
// Re-ingesting the same filing is a no-op; insertFact's UNIQUE(hash) plus
// the dedicated UNIQUE constraints on each sec_* table guarantee that.

import type { Env } from "../../types";
import { insertFact } from "../../entities/facts";
import type {
  ParsedFiling, FilingHeader, AdvPayload, FormDPayload,
  Form13FPayload, BeneficialOwner, Form4Trade, FormS1Payload,
  Form8KPayload, Form10KPayload, FormPFPayload,
} from "../../crawler/adapters/secEdgar";
export type { ParsedFiling } from "../../crawler/adapters/secEdgar";
import { resolveSecEntity } from "./xref";

export interface PersistResult {
  accession_no: string | null;
  entity_id: string | null;
  facts_written: number;
  rows_written: number;
  skipped: boolean;
  reason?: string;
}

async function recordFilingHeader(
  env: Env, h: FilingHeader, entityId: string | null, parsedPayload?: unknown,
): Promise<void> {
  if (!h.accession_no) return;
  const payloadJson = parsedPayload === undefined ? null : JSON.stringify(parsedPayload);
  await env.DB.prepare(
    `INSERT INTO sec_filings
       (accession_no, cik, form_type, filer_name, filed_at, period_of_report,
        filing_url, raw_url, primary_doc_url, parsed_payload_json,
        entity_id, ingest_status, errors, parsed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'parsed', NULL, CURRENT_TIMESTAMP)
     ON CONFLICT(accession_no) DO UPDATE SET
       entity_id = COALESCE(sec_filings.entity_id, excluded.entity_id),
       ingest_status = 'parsed',
       errors = NULL,
       parsed_at = CURRENT_TIMESTAMP,
       primary_doc_url = COALESCE(sec_filings.primary_doc_url, excluded.primary_doc_url),
       parsed_payload_json = COALESCE(excluded.parsed_payload_json, sec_filings.parsed_payload_json)`,
  ).bind(
    h.accession_no,
    h.cik ?? "",
    h.form_type ?? "UNKNOWN",
    h.filer_name,
    h.filed_at,
    h.period_of_report,
    h.filing_url,
    h.filing_url,         // raw_url (spec alias)
    h.primary_doc_url,
    payloadJson,
    entityId,
  ).run();
}

async function persistAdv(env: Env, h: FilingHeader, d: AdvPayload, source: string): Promise<PersistResult> {
  const xref = await resolveSecEntity(env, {
    name: d.adviser_name,
    kind: "org",
    cik: h.cik,
    crd: d.adviser_crd,
    jurisdiction: d.hq_country,
    source,
    role: "firm",
  });
  let facts = 0;
  let rows = 0;
  const factCtx = { entity_id: xref.entity_id, source_kind: "scrape" as const, source, confidence: 0.9 };

  if (d.total_aum_usd != null) {
    await insertFact(env, { ...factCtx, predicate: "aum_usd", value_number: d.total_aum_usd });
    facts++;
  }
  if (d.adviser_sec_no) {
    await insertFact(env, { ...factCtx, predicate: "sec.sec_file_number", value_text: d.adviser_sec_no });
    facts++;
  }
  if (h.filed_at) {
    await insertFact(env, { ...factCtx, predicate: "sec.form_adv.filed_at", value_text: h.filed_at });
    facts++;
  }
  if (d.employee_count != null) {
    await insertFact(env, { ...factCtx, predicate: "employees", value_number: d.employee_count });
    facts++;
  }
  if (d.hq_city) {
    await insertFact(env, { ...factCtx, predicate: "hq_city", value_text: d.hq_city });
    facts++;
  }
  if (d.website) {
    await insertFact(env, { ...factCtx, predicate: "website", value_text: d.website });
    facts++;
  }

  for (const fund of d.funds) {
    const fundXref = await resolveSecEntity(env, {
      name: fund.fund_name,
      kind: "org",
      crd: null,
      jurisdiction: fund.state_country,
      source,
      role: "fund",
    });
    await env.DB.prepare(
      `INSERT OR IGNORE INTO sec_form_adv_funds
         (id, accession_no, adviser_crd, adviser_sec_no, adviser_name,
          fund_name, fund_id_807, fund_type, gross_asset_value, beneficial_owners,
          minimum_investment, master_feeder, custodian, auditor, prime_broker,
          state_country, entity_id, adviser_entity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      crypto.randomUUID(), h.accession_no, d.adviser_crd, d.adviser_sec_no, d.adviser_name,
      fund.fund_name, fund.fund_id_807, fund.fund_type, fund.gross_asset_value, fund.beneficial_owners,
      fund.minimum_investment, fund.master_feeder, fund.custodian, fund.auditor, fund.prime_broker,
      fund.state_country, fundXref.entity_id, xref.entity_id,
    ).run();
    rows++;
    await insertFact(env, {
      ...factCtx,
      predicate: "sec.form_adv.fund",
      value_json: {
        fund_name: fund.fund_name,
        fund_id_807: fund.fund_id_807,
        fund_type: fund.fund_type,
        gross_asset_value: fund.gross_asset_value,
        adviser_entity_id: xref.entity_id,
      },
      value_entity_id: fundXref.entity_id,
    });
    facts++;
  }

  for (const cp of d.control_persons) {
    // Spec requires control persons disclosed on Form ADV be tagged
    // role='investor' (they are the GP/principals of an investment
    // adviser). Title-based gp/operator promotion happens downstream.
    const personXref = await resolveSecEntity(env, {
      name: cp.name,
      kind: "person",
      source,
      role: "investor",
    });
    await insertFact(env, {
      entity_id: personXref.entity_id,
      predicate: "person.career",
      value_json: {
        employer: d.adviser_name,
        employer_entity_id: xref.entity_id,
        title: cp.title,
        ownership_pct: cp.ownership_pct,
        source: "sec_form_adv",
      },
      source_kind: "scrape",
      source,
      confidence: 0.9,
    });
    facts++;
    await insertFact(env, {
      ...factCtx,
      predicate: "sec.gp_disclosed",
      value_text: cp.name,
      value_entity_id: personXref.entity_id,
    });
    facts++;
  }

  await recordFilingHeader(env, h, xref.entity_id, d);
  return { accession_no: h.accession_no, entity_id: xref.entity_id, facts_written: facts, rows_written: rows, skipped: false };
}

async function persistFormD(env: Env, h: FilingHeader, d: FormDPayload, source: string): Promise<PersistResult> {
  const xref = await resolveSecEntity(env, {
    name: d.issuer_name,
    kind: "org",
    cik: d.issuer_cik ?? h.cik,
    jurisdiction: d.issuer_jurisdiction,
    source,
    role: "company",
  });
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sec_form_d_rounds
       (id, accession_no, issuer_cik, issuer_name, issuer_jurisdiction, issuer_year_of_inc,
        industry_group, entity_type, total_offering_amount, total_amount_sold, total_remaining,
        minimum_investment, total_investors, date_of_first_sale, exemption_claimed,
        related_persons_json, is_amendment, entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), h.accession_no, d.issuer_cik, d.issuer_name, d.issuer_jurisdiction, d.issuer_year_of_inc,
    d.industry_group, d.entity_type, d.total_offering_amount, d.total_amount_sold, d.total_remaining,
    d.minimum_investment, d.total_investors, d.date_of_first_sale, d.exemption_claimed,
    JSON.stringify(d.related_persons), d.is_amendment ? 1 : 0, xref.entity_id,
  ).run();

  let facts = 0;
  const factCtx = { entity_id: xref.entity_id, source_kind: "scrape" as const, source, confidence: 0.9 };
  if (d.total_offering_amount != null) {
    await insertFact(env, { ...factCtx, predicate: "last_round_usd", value_number: d.total_offering_amount });
    facts++;
  }
  if (d.industry_group) {
    await insertFact(env, { ...factCtx, predicate: "sec.form_d.issuer_industry", value_text: d.industry_group });
    facts++;
  }
  if (d.issuer_year_of_inc) {
    await insertFact(env, { ...factCtx, predicate: "founded_year", value_number: d.issuer_year_of_inc });
    facts++;
  }
  await insertFact(env, {
    ...factCtx,
    predicate: "sec.form_d.round",
    value_json: {
      accession_no: h.accession_no,
      issuer_name: d.issuer_name,
      total_offering_amount: d.total_offering_amount,
      total_amount_sold: d.total_amount_sold,
      exemption_claimed: d.exemption_claimed,
      date_of_first_sale: d.date_of_first_sale,
      is_amendment: d.is_amendment,
    },
  });
  facts++;

  for (const rp of d.related_persons) {
    const personXref = await resolveSecEntity(env, { name: rp.name, kind: "person", source, role: "founder" });
    await insertFact(env, {
      entity_id: personXref.entity_id,
      predicate: "person.career",
      value_json: { employer: d.issuer_name, employer_entity_id: xref.entity_id, title: rp.role, source: "sec_form_d" },
      source_kind: "scrape", source, confidence: 0.85,
    });
    facts++;
  }

  await recordFilingHeader(env, h, xref.entity_id, d);
  // Task #3: synthesize a deal_event row from the already-parsed Form D
  // payload. The deal persist layer dedupes against any press-wire
  // corroboration for the same (company, round, month) bucket and
  // assigns SEC the highest source-authority rank. Best-effort: a
  // failure here must never block the structured Form D row.
  try {
    const { synthesizeDealFromFormD } = await import("../deals/persist");
    await synthesizeDealFromFormD(env, h, d);
  } catch (e) {
    console.warn("synthesizeDealFromFormD failed", h.accession_no, (e as Error).message);
  }
  return { accession_no: h.accession_no, entity_id: xref.entity_id, facts_written: facts, rows_written: 1, skipped: false };
}

async function persist13F(env: Env, h: FilingHeader, d: Form13FPayload, source: string): Promise<PersistResult> {
  const xref = await resolveSecEntity(env, {
    name: d.filer_name ?? "Unknown 13F Filer",
    kind: "org", cik: d.filer_cik ?? h.cik, source, role: "firm",
  });
  let rows = 0;
  // Cross-reference holdings to existing issuer entities by CUSIP.
  // Lookup-only (createIfMissing=false): a 13F can list 5000 positions
  // and minting a shell entity for every CUSIP would blow the entity
  // table. When the issuer was already created by another flow (S-1,
  // 10-K, Form D), the resulting `issuer_entity_id` joins the holding
  // to that entity; otherwise it stays NULL until an issuer-specific
  // adapter resolves the CUSIP.
  const cusipCache = new Map<string, string | null>();
  const resolveCusip = async (cusip: string, issuerName: string | null): Promise<string | null> => {
    if (cusipCache.has(cusip)) return cusipCache.get(cusip)!;
    const r = await resolveSecEntity(env, {
      name: issuerName ?? `CUSIP ${cusip}`,
      kind: "org",
      cusip,
      source,
      createIfMissing: false,
    });
    const id = r?.entity_id ?? null;
    cusipCache.set(cusip, id);
    return id;
  };
  // Bulk-insert holdings in batches. D1 caps statement size, so we chunk.
  const batchSize = 50;
  for (let i = 0; i < d.holdings.length; i += batchSize) {
    const slice = d.holdings.slice(i, i + batchSize);
    const stmts: D1PreparedStatement[] = [];
    for (const hold of slice) {
      const issuerEntityId = await resolveCusip(hold.cusip, hold.issuer_name);
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO sec_13f_holdings
           (id, accession_no, filer_cik, filer_name, period_of_report,
            cusip, issuer_name, title_of_class, value_usd, shares_or_principal,
            share_type, put_call, investment_discretion,
            voting_sole, voting_shared, voting_none,
            filer_entity_id, issuer_entity_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(), h.accession_no, d.filer_cik ?? "", d.filer_name, d.period_of_report ?? "",
        hold.cusip, hold.issuer_name, hold.title_of_class, hold.value_usd, hold.shares_or_principal,
        hold.share_type, hold.put_call, hold.investment_discretion,
        hold.voting_sole, hold.voting_shared, hold.voting_none,
        xref.entity_id, issuerEntityId,
      ));
    }
    await env.DB.batch(stmts);
    rows += slice.length;
  }
  let facts = 0;
  await insertFact(env, {
    entity_id: xref.entity_id,
    predicate: "sec.13f.filer_aum_usd",
    value_number: d.total_value_usd,
    source_kind: "scrape", source, confidence: 0.95,
    observed_at: d.period_of_report ? `${d.period_of_report}T00:00:00Z` : undefined,
  });
  facts++;
  await recordFilingHeader(env, h, xref.entity_id, d);
  return { accession_no: h.accession_no, entity_id: xref.entity_id, facts_written: facts, rows_written: rows, skipped: false };
}

async function persist13D(env: Env, h: FilingHeader, d: BeneficialOwner, source: string): Promise<PersistResult> {
  const ownerXref = await resolveSecEntity(env, {
    name: d.reporting_owner_name, kind: "org",
    cik: d.reporting_owner_cik ?? h.cik, source, role: "investor",
  });
  const issuerXref = d.issuer_name ? await resolveSecEntity(env, {
    name: d.issuer_name, kind: "org", cik: d.issuer_cik, source, role: "company",
  }) : null;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sec_insider_trades
       (id, accession_no, form_type, filer_cik, filer_name, reporting_owner_cik, reporting_owner_name,
        issuer_cik, issuer_name, percent_of_class, transaction_date,
        filer_entity_id, issuer_entity_id, owner_entity_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), h.accession_no, h.form_type ?? "SC 13D",
    h.cik ?? "", h.filer_name, d.reporting_owner_cik, d.reporting_owner_name,
    d.issuer_cik, d.issuer_name, d.percent_of_class, d.date_of_event,
    ownerXref.entity_id, issuerXref?.entity_id ?? null, ownerXref.entity_id,
  ).run();
  let facts = 0;
  await insertFact(env, {
    entity_id: ownerXref.entity_id,
    predicate: "sec.13d.beneficial_owner",
    value_json: {
      issuer_name: d.issuer_name,
      issuer_entity_id: issuerXref?.entity_id ?? null,
      shares_owned: d.shares_owned,
      percent_of_class: d.percent_of_class,
      date_of_event: d.date_of_event,
      accession_no: h.accession_no,
    },
    value_entity_id: issuerXref?.entity_id ?? null,
    source_kind: "scrape", source, confidence: 0.9,
  });
  facts++;
  await recordFilingHeader(env, h, ownerXref.entity_id, d);
  return { accession_no: h.accession_no, entity_id: ownerXref.entity_id, facts_written: facts, rows_written: 1, skipped: false };
}

async function persistForm4(env: Env, h: FilingHeader, d: Form4Trade, source: string): Promise<PersistResult> {
  const ownerXref = await resolveSecEntity(env, {
    name: d.reporting_owner_name, kind: "person",
    cik: d.reporting_owner_cik, source,
    role: d.is_officer ? "executive" : (d.is_director ? "board_member" : "investor"),
  });
  const issuerXref = d.issuer_name ? await resolveSecEntity(env, {
    name: d.issuer_name, kind: "org", cik: d.issuer_cik, ticker: d.issuer_ticker, source, role: "company",
  }) : null;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sec_insider_trades
       (id, accession_no, form_type, filer_cik, filer_name,
        reporting_owner_cik, reporting_owner_name,
        issuer_cik, issuer_name, issuer_ticker,
        is_director, is_officer, is_ten_percent_owner, is_other, officer_title,
        transaction_date, transaction_code, shares, price_per_share, shares_after,
        ownership_form, filer_entity_id, issuer_entity_id, owner_entity_id)
     VALUES (?, ?, '4', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    crypto.randomUUID(), h.accession_no, h.cik ?? "", h.filer_name,
    d.reporting_owner_cik, d.reporting_owner_name,
    d.issuer_cik, d.issuer_name, d.issuer_ticker,
    d.is_director ? 1 : 0, d.is_officer ? 1 : 0, d.is_ten_percent_owner ? 1 : 0, d.is_other ? 1 : 0, d.officer_title,
    d.transaction_date, d.transaction_code, d.shares, d.price_per_share, d.shares_after,
    d.ownership_form,
    ownerXref.entity_id, issuerXref?.entity_id ?? null, ownerXref.entity_id,
  ).run();
  let facts = 0;
  if (d.officer_title && d.is_officer) {
    await insertFact(env, {
      entity_id: ownerXref.entity_id,
      predicate: "sec.form4.officer_title",
      value_text: d.officer_title,
      source_kind: "scrape", source, confidence: 0.95,
    });
    facts++;
  }
  await insertFact(env, {
    entity_id: ownerXref.entity_id,
    predicate: "sec.form4.insider_trade",
    value_json: {
      issuer_name: d.issuer_name,
      issuer_ticker: d.issuer_ticker,
      transaction_date: d.transaction_date,
      transaction_code: d.transaction_code,
      shares: d.shares,
      price_per_share: d.price_per_share,
      ownership_form: d.ownership_form,
      accession_no: h.accession_no,
    },
    value_entity_id: issuerXref?.entity_id ?? null,
    source_kind: "scrape", source, confidence: 0.95,
    observed_at: d.transaction_date ? `${d.transaction_date}T00:00:00Z` : undefined,
  });
  facts++;
  await recordFilingHeader(env, h, ownerXref.entity_id, d);
  return { accession_no: h.accession_no, entity_id: ownerXref.entity_id, facts_written: facts, rows_written: 1, skipped: false };
}

async function persistS1(env: Env, h: FilingHeader, d: FormS1Payload, source: string): Promise<PersistResult> {
  const xref = await resolveSecEntity(env, {
    name: d.issuer_name, kind: "org", cik: d.issuer_cik ?? h.cik,
    ticker: d.ticker_symbol, source, role: "company",
  });
  let facts = 0;
  const ctx = { entity_id: xref.entity_id, source_kind: "scrape" as const, source, confidence: 0.9 };
  await insertFact(env, { ...ctx, predicate: "sec.s1.ipo_intent", value_text: h.filed_at ?? "true" });
  facts++;
  if (d.proposed_max_offering_usd != null) {
    await insertFact(env, { ...ctx, predicate: "last_round_usd", value_number: d.proposed_max_offering_usd });
    facts++;
  }
  for (const uw of d.underwriters) {
    await insertFact(env, { ...ctx, predicate: "sec.s1.underwriter", value_text: uw });
    facts++;
  }
  await recordFilingHeader(env, h, xref.entity_id, d);
  return { accession_no: h.accession_no, entity_id: xref.entity_id, facts_written: facts, rows_written: 0, skipped: false };
}

async function persist8K(env: Env, h: FilingHeader, d: Form8KPayload, source: string): Promise<PersistResult> {
  const xref = await resolveSecEntity(env, {
    name: d.issuer_name, kind: "org", cik: d.issuer_cik ?? h.cik, source, role: "company",
  });
  let facts = 0;
  for (const item of d.items) {
    await insertFact(env, {
      entity_id: xref.entity_id,
      predicate: "sec.8k.material_event",
      value_json: { item: item.item_number, title: item.item_title, summary: item.summary, event_date: d.event_date, accession_no: h.accession_no },
      source_kind: "scrape", source, confidence: 0.9,
      observed_at: d.event_date ? `${d.event_date}T00:00:00Z` : undefined,
    });
    facts++;
  }
  await recordFilingHeader(env, h, xref.entity_id, d);
  // Task #3: synthesize deal_events from 8-K items that map to funding
  // / acquisition events (Item 1.01, 2.01, 3.02, 8.01). Best-effort.
  try {
    const { synthesizeDealFromForm8K } = await import("../deals/persist");
    await synthesizeDealFromForm8K(env, h, d);
  } catch (e) {
    console.warn("synthesizeDealFromForm8K failed", h.accession_no, (e as Error).message);
  }
  return { accession_no: h.accession_no, entity_id: xref.entity_id, facts_written: facts, rows_written: 0, skipped: false };
}

async function persist10K(env: Env, h: FilingHeader, d: Form10KPayload, source: string): Promise<PersistResult> {
  const xref = await resolveSecEntity(env, {
    name: d.issuer_name, kind: "org", cik: d.issuer_cik ?? h.cik, source, role: "company",
  });
  let facts = 0;
  const ctx = { entity_id: xref.entity_id, source_kind: "scrape" as const, source, confidence: 0.95 };
  if (d.revenue_usd != null) { await insertFact(env, { ...ctx, predicate: "sec.10k.revenue_usd", value_number: d.revenue_usd }); facts++; }
  if (d.net_income_usd != null) { await insertFact(env, { ...ctx, predicate: "sec.10k.net_income_usd", value_number: d.net_income_usd }); facts++; }
  if (d.fiscal_year_end) { await insertFact(env, { ...ctx, predicate: "sec.10k.fiscal_year_end", value_text: d.fiscal_year_end }); facts++; }
  for (const exec of d.executives) {
    const execXref = await resolveSecEntity(env, { name: exec.name, kind: "person", source, role: "executive" });
    await insertFact(env, {
      entity_id: execXref.entity_id,
      predicate: "person.career",
      value_json: { employer: d.issuer_name, employer_entity_id: xref.entity_id, title: exec.title, total_compensation_usd: exec.total_compensation_usd, source: "sec_10k" },
      source_kind: "scrape", source, confidence: 0.9,
    });
    facts++;
    await insertFact(env, { ...ctx, predicate: "sec.10k.executive", value_json: { name: exec.name, title: exec.title, total_compensation_usd: exec.total_compensation_usd }, value_entity_id: execXref.entity_id });
    facts++;
  }
  await recordFilingHeader(env, h, xref.entity_id, d);
  return { accession_no: h.accession_no, entity_id: xref.entity_id, facts_written: facts, rows_written: 0, skipped: false };
}

async function persistPF(env: Env, h: FilingHeader, d: FormPFPayload, source: string): Promise<PersistResult> {
  const xref = await resolveSecEntity(env, {
    name: d.adviser_name, kind: "org", cik: h.cik, crd: d.adviser_crd, source, role: "firm",
  });
  let facts = 0;
  const ctx = { entity_id: xref.entity_id, source_kind: "scrape" as const, source, confidence: 0.95 };
  if (d.total_regulatory_aum_usd != null) { await insertFact(env, { ...ctx, predicate: "aum_usd", value_number: d.total_regulatory_aum_usd }); facts++; }
  for (const f of d.funds) {
    const fundXref = await resolveSecEntity(env, { name: f.fund_name, kind: "org", source, role: "fund" });
    await insertFact(env, {
      ...ctx, predicate: "sec.pf.fund",
      value_json: { fund_name: f.fund_name, fund_id_807: f.fund_id_807, gross_asset_value: f.gross_asset_value, net_asset_value: f.net_asset_value, fund_type: f.fund_type },
      value_entity_id: fundXref.entity_id,
    });
    facts++;
  }
  await recordFilingHeader(env, h, xref.entity_id, d);
  return { accession_no: h.accession_no, entity_id: xref.entity_id, facts_written: facts, rows_written: 0, skipped: false };
}

/**
 * Quality gate. Form parsers are deliberately tolerant — they return
 * sparse payloads on degraded HTML rather than throwing — but persisting
 * a sparse payload would set `ingest_status='parsed'` and then
 * permanently short-circuit later attempts at the same accession_no
 * (see the already_parsed gate below). For each form we require a
 * minimum set of required-fields-present before declaring the parse
 * "real"; otherwise we return skipped+pending so a higher-fidelity
 * re-crawl (e.g. fetching the primary_doc_url XML directly) can ingest.
 */
function isPayloadSufficient(parsed: ParsedFiling): boolean {
  switch (parsed.kind) {
    case "adv":    return Boolean(parsed.data.adviser_crd) || parsed.data.funds.length > 0 || parsed.data.total_aum_usd != null;
    case "form_d": return parsed.data.total_offering_amount != null || parsed.data.total_amount_sold != null || parsed.data.related_persons.length > 0;
    case "13f":    return parsed.data.holdings.length > 0 && Boolean(parsed.data.period_of_report) && Boolean(parsed.data.filer_cik);
    case "13d":    return Boolean(parsed.data.issuer_name) && (parsed.data.shares_owned != null || parsed.data.percent_of_class != null);
    case "form4":  return Boolean(parsed.data.transaction_code) && parsed.data.shares != null && Boolean(parsed.data.issuer_cik);
    case "s1":     return parsed.data.proposed_max_offering_usd != null || parsed.data.underwriters.length > 0;
    case "8k":     return parsed.data.items.length > 0;
    case "10k":
    case "10q":    return parsed.data.revenue_usd != null || parsed.data.net_income_usd != null || parsed.data.executives.length > 0;
    case "pf":     return parsed.data.funds.length > 0 || parsed.data.total_regulatory_aum_usd != null;
    case "index":  return false;
  }
}

/**
 * Top-level persister. Routes on parsed.kind and delegates. Idempotent:
 * re-ingesting the same accession_no is a near-no-op (existing facts
 * refresh observed_at; sec_* INSERT OR IGNOREs are no-ops).
 */
export async function persistParsedFiling(env: Env, parsed: ParsedFiling, source = "edgar"): Promise<PersistResult> {
  // Skip filings without an accession_no — we can't dedup them, and the
  // engine has likely picked up a search-results page that should not be
  // persisted as a filing.
  if (!parsed.header.accession_no && parsed.kind !== "index") {
    return { accession_no: null, entity_id: null, facts_written: 0, rows_written: 0, skipped: true, reason: "no_accession" };
  }
  // Parser-exception path: parseEdgarPage stamps header.parser_error
  // and degrades to an index parse. Before the `index` branch
  // short-circuits below, record the failure to sec_filings so the
  // operator dashboard can surface it and a retry pass can re-fetch.
  if (parsed.header.parser_error && parsed.header.accession_no) {
    await env.DB.prepare(
      `INSERT INTO sec_filings (accession_no, cik, form_type, filer_name, filed_at, filing_url, raw_url, primary_doc_url, ingest_status, errors)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?)
       ON CONFLICT(accession_no) DO UPDATE SET
         ingest_status = 'failed',
         errors = excluded.errors`,
    ).bind(
      parsed.header.accession_no, parsed.header.cik ?? "",
      parsed.header.form_type ?? "UNKNOWN", parsed.header.filer_name,
      parsed.header.filed_at, parsed.header.filing_url, parsed.header.filing_url,
      parsed.header.primary_doc_url,
      parsed.header.parser_error.slice(0, 500),
    ).run().catch(() => undefined);
    return { accession_no: parsed.header.accession_no, entity_id: null, facts_written: 0, rows_written: 0, skipped: true, reason: "parser_error" };
  }
  // Quality gate: refuse to mark a filing 'parsed' from a sparse/empty
  // payload. Leaves sec_filings row (if any) in 'pending' so the
  // engine can re-crawl the primary_doc_url and try again. We DO record
  // an error so operators can see why the filing keeps coming back.
  if (parsed.kind !== "index" && !isPayloadSufficient(parsed)) {
    if (parsed.header.accession_no) {
      await env.DB.prepare(
        `INSERT INTO sec_filings (accession_no, cik, form_type, filer_name, filed_at, filing_url, raw_url, primary_doc_url, ingest_status, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
         ON CONFLICT(accession_no) DO UPDATE SET
           errors = excluded.errors,
           primary_doc_url = COALESCE(sec_filings.primary_doc_url, excluded.primary_doc_url)`,
      ).bind(
        parsed.header.accession_no, parsed.header.cik ?? "",
        parsed.header.form_type ?? "UNKNOWN", parsed.header.filer_name,
        parsed.header.filed_at, parsed.header.filing_url, parsed.header.filing_url,
        parsed.header.primary_doc_url,
        `payload_insufficient: ${parsed.kind} parser returned a sparse payload`,
      ).run().catch(() => undefined);
    }
    return { accession_no: parsed.header.accession_no, entity_id: null, facts_written: 0, rows_written: 0, skipped: true, reason: "payload_insufficient" };
  }
  // Short-circuit on already-parsed filings so re-crawls don't churn.
  if (parsed.header.accession_no) {
    const existing = await env.DB.prepare(
      `SELECT ingest_status FROM sec_filings WHERE accession_no = ?`,
    ).bind(parsed.header.accession_no).first<{ ingest_status: string }>();
    if (existing?.ingest_status === "parsed") {
      return { accession_no: parsed.header.accession_no, entity_id: null, facts_written: 0, rows_written: 0, skipped: true, reason: "already_parsed" };
    }
  }

  try {
    switch (parsed.kind) {
      case "adv":    return await persistAdv(env, parsed.header, parsed.data, source);
      case "form_d": return await persistFormD(env, parsed.header, parsed.data, source);
      case "13f":    return await persist13F(env, parsed.header, parsed.data, source);
      case "13d":    return await persist13D(env, parsed.header, parsed.data, source);
      case "form4":  return await persistForm4(env, parsed.header, parsed.data, source);
      case "s1":     return await persistS1(env, parsed.header, parsed.data, source);
      case "8k":     return await persist8K(env, parsed.header, parsed.data, source);
      case "10k":
      case "10q":    return await persist10K(env, parsed.header, parsed.data, source);
      case "pf":     return await persistPF(env, parsed.header, parsed.data, source);
      case "index":
        // Index pages don't persist a filing — discovery handles them.
        return { accession_no: null, entity_id: null, facts_written: 0, rows_written: 0, skipped: true, reason: "index_page" };
    }
  } catch (e) {
    // Spec: malformed filings record an error in sec_filings.errors and
    // never silently swallow data. We INSERT-or-UPDATE so a failure
    // before any per-form sec_* write still leaves a ledger row.
    if (parsed.header.accession_no) {
      await env.DB.prepare(
        `INSERT INTO sec_filings (accession_no, cik, form_type, filer_name, filed_at, filing_url, raw_url, primary_doc_url, ingest_status, errors)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'failed', ?)
         ON CONFLICT(accession_no) DO UPDATE SET
           ingest_status = 'failed',
           errors = excluded.errors`,
      ).bind(
        parsed.header.accession_no, parsed.header.cik ?? "",
        parsed.header.form_type ?? "UNKNOWN", parsed.header.filer_name,
        parsed.header.filed_at, parsed.header.filing_url, parsed.header.filing_url,
        parsed.header.primary_doc_url,
        (e as Error).message.slice(0, 500),
      ).run().catch(() => undefined);
    }
    throw e;
  }
}
