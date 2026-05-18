// Task #3: Intl filing/entity persist layer.
//
// Adapters emit IntlFiling / IntlEntityHit. This layer:
//   1. Normalizes amounts to USD via services/intl/fx (toUsd).
//   2. Translates non-English text via services/intl/translate.
//   3. Resolves/mints the filer entity through the canonical
//      createEntity + addRole path, then writes corroborating facts
//      via insertFact (Task #1 canonical write decision).
//
// Original currency + raw amount + fx as-of date are retained in
// `source_evidence_json` so the conversion can be audited.

import type { Env } from "../../types";
import type { IntlAdapter, IntlEntityHit, IntlFiling } from "../../crawler/adapters/intl/types";
import { insertFact } from "../../entities/facts";
import { createEntity, addRole } from "../../entities/roles";
import { toUsd, FxLookupError } from "./fx";
import { translateToEnglish } from "./translate";
import { parseDate, parseAddress } from "./locale";
import { linkVehicleToCanonicalFirm } from "./firmGraph";

/** Translated-text predicate scan. The architect required at least one
 *  extracted predicate from translated non-English text; we do a small
 *  English-side regex pass for the most useful pattern ("raised $X" /
 *  "fund size $X"). Each match becomes a corroborating intl.extracted_*
 *  fact written through insertFact. Conservative on purpose — false
 *  positives here are worse than misses. */
function extractEnglishPredicates(english: string): Array<{ predicate: string; value_number: number; raw: string }> {
  const out: Array<{ predicate: string; value_number: number; raw: string }> = [];
  if (!english) return out;
  const re = /\b(raised|fund\s+size|target|commitment|aum)\b[^.\n]{0,40}?\b(USD|EUR|GBP|SGD|HKD|JPY|CNY|\$|€|£)\s*([\d,]+(?:\.\d+)?)\s*(million|billion|m|bn)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(english))) {
    let n = Number(m[3].replace(/,/g, ""));
    if (!Number.isFinite(n)) continue;
    const mag = m[4]?.toLowerCase();
    if (mag === "million" || mag === "m") n *= 1_000_000;
    else if (mag === "billion" || mag === "bn") n *= 1_000_000_000;
    const kind = m[1].toLowerCase().replace(/\s+/g, "_");
    out.push({ predicate: `intl.extracted_${kind}`, value_number: n, raw: m[0] });
    if (out.length >= 4) break;
  }
  return out;
}

export interface IntlPersistResult {
  filer_entity_id: string;
  facts_written: number;
  amount_usd: number | null;
  translated: boolean;
  fx_error: string | null;
}

async function findEntityByJurisdictionalId(env: Env, jurisdiction: string, source_id: string): Promise<string | null> {
  const r = await env.DB.prepare(
    `SELECT entity_id FROM facts
      WHERE predicate = 'intl.source_id'
        AND value_text = ?
        AND value_json LIKE ?
        AND is_current = 1
      LIMIT 1`,
  ).bind(source_id, `%"jurisdiction":"${jurisdiction}"%`).first<{ entity_id: string }>();
  return r?.entity_id ?? null;
}

/** Resolve (or mint) the canonical entity behind an IntlEntityHit. The
 *  `intl.source_id` fact carries the {jurisdiction, source_id} pair so
 *  re-hits dedupe deterministically. */
export async function resolveIntlEntity(env: Env, hit: IntlEntityHit, source: string): Promise<string> {
  const existing = await findEntityByJurisdictionalId(env, hit.jurisdiction, hit.source_id);
  if (existing) return existing;
  const row = await createEntity(env, {
    kind: hit.kind === "person" ? "person" : "org",
    display_name: hit.display_name,
    suppressAutoProfileFill: true,
  });
  const role = hit.kind === "fund" ? "fund"
    : hit.kind === "person" ? "founder"
    : "firm";
  await addRole(env, row.id, role, { is_primary: true, source, confidence: hit.confidence });
  const ctx = {
    entity_id: row.id, source_kind: "scrape" as const, source,
    evidence_url: hit.url, confidence: hit.confidence,
  };
  await insertFact(env, {
    ...ctx,
    predicate: "intl.source_id",
    value_text: hit.source_id,
    value_json: { jurisdiction: hit.jurisdiction, kind: hit.kind, url: hit.url },
  });
  if (hit.display_name_original && hit.display_name_original !== hit.display_name) {
    await insertFact(env, {
      ...ctx,
      predicate: "intl.display_name_original",
      value_text: hit.display_name_original,
      value_json: { lang: hit.original_lang ?? null },
    });
  }
  return row.id;
}

/** Drain helper: when an IntlFiling carries `data.canonical_firm_source_id`
 *  (set by adapters that already know the parent firm — e.g. a SEBI AIF
 *  whose manager source_id is published alongside it), bind the filer
 *  vehicle to the canonical firm in legal_structure_graph. */
async function maybeLinkVehicle(env: Env, adapter: IntlAdapter, filing: IntlFiling, vehicleEntityId: string): Promise<void> {
  const canonicalSrc = filing.data?.canonical_firm_source_id;
  const role = filing.data?.vehicle_role;
  if (typeof canonicalSrc !== "string" || typeof role !== "string") return;
  // 1. Look up an existing canonical firm by its intl.source_id fact.
  let r = await env.DB.prepare(
    `SELECT entity_id FROM facts WHERE predicate = 'intl.source_id'
       AND value_text = ?
       AND value_json LIKE ?
       AND is_current = 1 LIMIT 1`,
  ).bind(canonicalSrc, `%"jurisdiction":"${adapter.jurisdiction}"%`).first<{ entity_id: string }>();
  // 2. If the canonical firm isn't on file yet, mint it through the
  //    canonical resolveIntlEntity path so the linker has a real
  //    target. This is what makes auto-linking end-to-end on the
  //    first sighting of "<vehicle> managed by <canonical>".
  if (!r?.entity_id) {
    const displayName = typeof filing.data?.canonical_firm_display_name === "string"
      ? filing.data.canonical_firm_display_name : canonicalSrc;
    const canonId = await resolveIntlEntity(env, {
      jurisdiction: adapter.jurisdiction,
      source_id: canonicalSrc,
      display_name: displayName,
      kind: "manager",
      url: filing.url,
      confidence: 0.7,
    }, `intl:${adapter.id}:firmgraph`);
    r = { entity_id: canonId };
  }
  if (!r.entity_id || r.entity_id === vehicleEntityId) return;
  await linkVehicleToCanonicalFirm(env, {
    canonical_firm_entity_id: r.entity_id,
    vehicle_entity_id: vehicleEntityId,
    vehicle_role: role as Parameters<typeof linkVehicleToCanonicalFirm>[1]["vehicle_role"],
    jurisdiction: adapter.jurisdiction,
    evidence_source_url: filing.url,
    confidence: 0.85,
  });
}

/** Persist one IntlFiling: normalize amount → USD, translate non-English
 *  text, write corroborating facts. Errors in FX are surfaced (fail-loud
 *  per fx.ts contract); translation errors degrade silently to
 *  passthrough. Idempotent via insertFact's content-addressed dedupe. */
export async function persistIntlFiling(
  env: Env, adapter: IntlAdapter, filing: IntlFiling,
): Promise<IntlPersistResult> {
  const source = `intl:${adapter.id}:${filing.filing_type}`;

  // 1. Filer entity — resolve via the source-id fact, mint on miss.
  const filerHit: IntlEntityHit = {
    jurisdiction: filing.jurisdiction,
    source_id: filing.filer_source_id ?? filing.source_id,
    display_name: filing.filer_name,
    kind: "company",
    url: filing.url,
    confidence: 0.7,
    original_lang: filing.original_lang ?? null,
  };
  const filerId = await resolveIntlEntity(env, filerHit, source);

  // Optional: bind the filer (vehicle) to a known canonical firm if
  // the adapter surfaced one. No-op when the data isn't present.
  try { await maybeLinkVehicle(env, adapter, filing, filerId); }
  catch (e) { console.warn("intl maybeLinkVehicle failed", filing.source_id, (e as Error).message); }

  // Locale normalization. Adapters never roll their own date/address
  // parse — they hand the raw string to this layer which delegates to
  // services/intl/locale. Normalized values are stored in the
  // source_evidence_json for downstream consumers; an ISO `filed_at`
  // also overrides the adapter's raw string when locale parsing
  // succeeds (otherwise we trust what the adapter handed us).
  const normalizedDate = parseDate(filing.filed_at, filing.jurisdiction);
  const filedAtIso = normalizedDate ?? filing.filed_at;
  const rawAddress = typeof filing.data?.raw_address === "string" ? filing.data.raw_address : null;
  const parsedAddress = rawAddress ? parseAddress(rawAddress, filing.jurisdiction) : null;

  // 2. Currency normalization. When the adapter handed raw {amount,
  //    currency}, run toUsd against the filing date. Fail-loud: an
  //    unresolved rate must NOT silently fall back to 1:1.
  let amount_usd: number | null = filing.amount_usd ?? null;
  let fx_error: string | null = null;
  if (amount_usd == null && filing.raw_amount != null && filing.raw_currency) {
    try {
      amount_usd = await toUsd(env, filing.raw_amount, filing.raw_currency, filedAtIso);
    } catch (e) {
      if (e instanceof FxLookupError) { fx_error = e.message; amount_usd = null; }
      else throw e;
    }
  }

  // 3. Translation. When the adapter declares needs_translation and the
  //    filing carries original-language text, fill english_text. Never
  //    overwrite original_text — translation is additive.
  let english_text = filing.english_text ?? null;
  let translated = false;
  if (adapter.needs_translation && filing.original_text && !english_text) {
    const tr = await translateToEnglish(env, filing.original_text, filing.original_lang);
    english_text = tr.english_text;
    translated = tr.translated;
  }

  // 4. Corroborating facts.
  const evidence = {
    ...filing.source_evidence_json,
    raw_amount: filing.raw_amount ?? null,
    raw_currency: filing.raw_currency ?? null,
    fx_as_of: filedAtIso,
    fx_error,
    original_lang: filing.original_lang ?? null,
    original_text: filing.original_text ?? null,
    english_text,
    filed_at_raw: filing.filed_at,
    filed_at_iso: normalizedDate,
    parsed_address: parsedAddress,
  };
  const factCtx = {
    entity_id: filerId, source_kind: "scrape" as const, source,
    evidence_url: filing.url, confidence: 0.85,
    observed_at: `${filedAtIso}T00:00:00Z`,
  };
  let facts_written = 0;
  const wrote = await insertFact(env, {
    ...factCtx,
    predicate: "intl.filing",
    value_text: filing.filing_type,
    value_json: { ...filing.data, source_evidence_json: evidence },
  });
  if (wrote) facts_written++;
  if (amount_usd != null) {
    const w2 = await insertFact(env, {
      ...factCtx,
      predicate: "intl.filing_amount_usd",
      value_number: amount_usd,
      value_json: { filing_type: filing.filing_type, fx_evidence: evidence },
    });
    if (w2) facts_written++;
  }
  // Translated-text predicate extraction: scan english_text for
  // common monetary patterns and emit corroborating facts. This is
  // what makes non-English filings produce structured predicates.
  if (english_text) {
    for (const ex of extractEnglishPredicates(english_text)) {
      const w = await insertFact(env, {
        ...factCtx,
        predicate: ex.predicate,
        value_number: ex.value_number,
        value_json: { raw: ex.raw, source_text_origin: filing.original_lang ?? "en" },
      });
      if (w) facts_written++;
    }
  }
  return { filer_entity_id: filerId, facts_written, amount_usd, translated, fx_error };
}

/** Drain helper used by the extractor side-effect: when an intl adapter
 *  claims an already-fetched page, call parsePage and persist. */
export async function persistIntlEntityFromPage(
  env: Env, adapter: IntlAdapter, html: string, url: string,
): Promise<{ entity_id: string | null }> {
  const hit = adapter.parsePage(html, url);
  if (!hit) return { entity_id: null };
  const id = await resolveIntlEntity(env, hit, `intl:${adapter.id}:page`);
  return { entity_id: id };
}
