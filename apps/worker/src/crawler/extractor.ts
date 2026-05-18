// Task #6: Extractor chain. Run in sequence; first success wins, but
// later steps still enrich. JSON-LD / microdata / OG / Readability run
// before any AI call so the neuron cap isn't burned on pages with rich
// structured data. The Workers AI semantic pass is keyed to the
// profile-types registry: it reads the candidate type's enrichment
// predicates and asks the model to extract values for them with a
// strict JSON schema. Invalid output is retried once at lower
// temperature; second failure returns `{}` with confidence:0.

import type { Env } from "../types";
import { loadRegistry, testPage, type ProfileType } from "../services/profileTypes";
import { classifyPage, isNewsLike, type PageClassification, type PageType } from "../services/pageClassifier";
import { runAdapter } from "./adapters";

// Task #1 step 5: classifier-authoritative routing. Single source of
// truth that maps a page_type to a downstream commit route. News-like
// types go to the news pipeline; surface-level entity pages
// (company_home / team_page / profile) go to the entity persister;
// directory hubs and unknown pages are explicitly skipped so the
// PredicateRouter never commits ambiguous rows.
function routeForPageType(pt: PageType): "entity" | "news_item" | "skip" {
  if (isNewsLike(pt)) return "news_item";
  if (pt === "profile" || pt === "team_page" || pt === "company_home") return "entity";
  return "skip";
}

export interface ExtractedCandidate {
  profile_type: string | null;
  confidence: number;
  source: "json_ld" | "microdata" | "open_graph" | "readability" | "ai_semantic";
  name?: string | null;
  url?: string | null;
  data: Record<string, unknown>;
}

export interface ExtractionResult {
  url: string;
  matched_types: Array<{ type_id: string; confidence: number; fired_signals: string[] }>;
  candidates: ExtractedCandidate[];
  used_ai: boolean;
  ai_error: string | null;
  // Task #1 step 5: classifier decides whether the persister should
  // commit an entity, a news item, or skip. The crawler preview surface
  // returns this verbatim; the PredicateRouter consumes `route` to
  // pick the right table downstream.
  classification: PageClassification | null;
  route: "entity" | "news_item" | "skip";
  // Task #2: when a site adapter claimed the URL and produced a result,
  // its id and child-URL set are surfaced here. `adapter_fallback`
  // explains why we fell through to the generic extractor when the
  // adapter was skipped.
  adapter_used: string | null;
  adapter_fallback: "no_adapter" | "adapter_threw" | "low_confidence" | null;
  adapter_error: string | null;
  child_urls: string[];
  // Task #3: structured failure records from intl dispatch. Empty (or
  // omitted) when nothing went wrong. Surfaced verbatim so acceptance
  // probes see explicit per-adapter failures instead of silent skips.
  errors?: Array<{ stage: "intl_parse" | "intl_persist"; adapter_id: string; url: string; message: string }>;
}

function parseJsonLd(html: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    try {
      const j = JSON.parse(m[1].trim());
      if (Array.isArray(j)) out.push(...j as Array<Record<string, unknown>>);
      else if (j && typeof j === "object") out.push(j as Record<string, unknown>);
    } catch { /* skip malformed block */ }
  }
  return out;
}

function parseOpenGraph(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const metaRe = /<meta\s+([^>]+)>/gi;
  let m: RegExpExecArray | null;
  while ((m = metaRe.exec(html))) {
    const attrs = m[1];
    const prop = attrs.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1];
    const content = attrs.match(/\bcontent=["']([^"']*)["']/i)?.[1];
    if (prop && content && (prop.startsWith("og:") || prop.startsWith("twitter:"))) {
      out[prop] = content;
    }
  }
  return out;
}

function parseMicrodata(html: string): Array<{ itemtype: string; props: Record<string, string> }> {
  // Cheap pass: pull `itemtype` blocks; we don't fully implement the
  // microdata spec but surface enough to enrich a JSON-LD miss.
  const out: Array<{ itemtype: string; props: Record<string, string> }> = [];
  const scopeRe = /<[^>]+itemscope[^>]*itemtype=["']([^"']+)["'][^>]*>([\s\S]*?)<\/[a-z]+>/gi;
  let m: RegExpExecArray | null;
  while ((m = scopeRe.exec(html))) {
    const props: Record<string, string> = {};
    const propRe = /itemprop=["']([^"']+)["'][^>]*>([^<]+)</gi;
    let pm: RegExpExecArray | null;
    while ((pm = propRe.exec(m[2]))) props[pm[1]] = pm[2].trim();
    out.push({ itemtype: m[1], props });
  }
  return out;
}

function readabilityText(html: string): string {
  // Cheap readability: drop scripts/styles/nav/footer; keep body text.
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped;
}

function nameFromJsonLd(node: Record<string, unknown>): string | null {
  const n = node.name; return typeof n === "string" ? n : null;
}

function pickProfileTypeForJsonLd(node: Record<string, unknown>): string | null {
  const t = node["@type"];
  const types = Array.isArray(t) ? t : [t];
  if (types.includes("Organization") || types.includes("Corporation")) return null; // generic
  if (types.includes("Person")) return "firm_person";
  return null;
}

async function aiSemanticPass(
  env: Env,
  type: ProfileType,
  page: { url: string; text: string; title: string },
): Promise<{ data: Record<string, unknown>; confidence: number; error: string | null }> {
  if (!env.AI) return { data: {}, confidence: 0, error: "ai_binding_unavailable" };
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const predicateProps: Record<string, { type: string }> = {};
  for (const p of type.enrichment_predicates) predicateProps[p] = { type: "string" };
  const schema = {
    type: "object",
    properties: { ...predicateProps, confidence: { type: "number" } },
    required: ["confidence"],
  } as const;
  const sys = `You extract structured data from a single web page. Page is a candidate "${type.label}" (${type.id}). Return strict JSON with only these keys: ${type.enrichment_predicates.join(", ")}, plus a "confidence" between 0 and 1. Use empty string when unknown. No prose.`;
  const usr = `URL: ${page.url}\nTitle: ${page.title}\n\nPage text (truncated):\n${page.text.slice(0, 8000)}`;
  const tryOnce = async (temperature: number): Promise<{ data: Record<string, unknown>; confidence: number } | null> => {
    try {
      const ai = env.AI;
      if (!ai) return null;
      const res = await Promise.race([
        ai.run(model, {
          messages: [{ role: "system", content: sys }, { role: "user", content: usr }],
          response_format: { type: "json_schema", json_schema: schema },
          temperature,
        }) as Promise<{ response?: string; confidence?: number } & Record<string, unknown>>,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ai_timeout")), 30_000)),
      ]);
      let obj: Record<string, unknown> = {};
      if (typeof res?.response === "string") {
        try { obj = JSON.parse(res.response) as Record<string, unknown>; } catch { return null; }
      } else if (res && typeof res === "object") {
        obj = res as Record<string, unknown>;
      }
      const confRaw = obj.confidence; const conf = typeof confRaw === "number" ? confRaw : Number(confRaw ?? 0);
      if (Number.isNaN(conf)) return null;
      const data: Record<string, unknown> = {};
      for (const p of type.enrichment_predicates) if (obj[p] != null && obj[p] !== "") data[p] = obj[p];
      return { data, confidence: Math.max(0, Math.min(1, conf)) };
    } catch { return null; }
  };
  const first = await tryOnce(0.2);
  if (first) return { data: first.data, confidence: first.confidence, error: null };
  const retry = await tryOnce(0.0);
  if (retry) return { data: retry.data, confidence: retry.confidence, error: null };
  return { data: {}, confidence: 0, error: "ai_invalid_json" };
}

export async function extractCandidates(
  env: Env,
  url: string,
  html: string,
  opts: { profileTypeHint?: string; intlJurisdictionHint?: import("./adapters/intl/types").JurisdictionCode | null } = {},
): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    url, matched_types: [], candidates: [], used_ai: false, ai_error: null,
    classification: null, route: "skip",
    adapter_used: null, adapter_fallback: null, adapter_error: null, child_urls: [],
    errors: [],
  };
  if (!html) return result;

  // Task #2 step 2: try a site-specific adapter first. On a confident
  // result we still run the generic chain (so JSON-LD / OG / Readability
  // / classifier all enrich the same candidate list), but the adapter's
  // candidates take precedence in downstream merge ordering. On a
  // throw / low-confidence / no-match we record the fallback reason and
  // proceed exactly as before — a broken adapter must never block.
  const adapterOutcome = runAdapter(url, html);
  result.adapter_used = adapterOutcome.used_adapter_id;
  result.adapter_fallback = adapterOutcome.fallback_reason;
  result.adapter_error = adapterOutcome.adapter_error;
  if (adapterOutcome.result) {
    for (const c of adapterOutcome.result.candidates) {
      result.candidates.push({
        profile_type: c.profile_type,
        confidence: c.confidence,
        source: "ai_semantic", // tagged as semantic for downstream merge weight
        name: c.name ?? null,
        url: c.url ?? url,
        data: c.data,
      });
    }
    result.child_urls = adapterOutcome.result.child_urls.slice(0, 500);

    // Task #1: SEC EDGAR deep-adapter side-effect. The secEdgar adapter
    // attaches a typed `parsed` ParsedFiling payload to candidate.data;
    // route it through the dedicated persist layer (insertFact + sec_*
    // tables, idempotent on accession_no). A persist failure must never
    // block the rest of extraction — we log and move on.
    if (adapterOutcome.used_adapter_id === "sec_edgar") {
      const cand = adapterOutcome.result.candidates[0];
      const parsed = (cand?.data as Record<string, unknown> | undefined)?.parsed as
        import("../services/secEdgar/persist").ParsedFiling | undefined;
      // Persist non-index parses AND any parse that was downgraded to
      // `index` because the per-form parser threw (header.parser_error
      // is set). The latter is essential: without it, malformed
      // filings would slip past the `kind !== "index"` guard and
      // never reach the persist layer's error-recording path,
      // violating the spec contract that sec_filings.errors captures
      // every malformed filing.
      if (parsed && (parsed.kind !== "index" || parsed.header?.parser_error)) {
        try {
          const { persistParsedFiling } = await import("../services/secEdgar/persist");
          await persistParsedFiling(env, parsed, "edgar_crawler");
        } catch (e) {
          console.warn("secEdgar persist failed", url, (e as Error).message);
        }
      }
    }

    // Task #2: LP-disclosure persist side-effect. Every LP adapter
    // emits `profile_type === 'lp_disclosure'` with a typed
    // LpDisclosurePayload in `candidate.data`. Route each through the
    // dedicated persist layer (lp_fund_commitments + canonical fact
    // writes, idempotent on UNIQUE(lp_entity_id, fund_name_raw,
    // as_of_date)). A persist failure must never block extraction.
    for (const cand of adapterOutcome.result.candidates) {
      if (cand.profile_type !== "lp_disclosure") continue;
      const payload = cand.data as unknown as
        import("../crawler/adapters/lpDisclosures/types").LpDisclosurePayload | undefined;
      if (!payload || !Array.isArray(payload.commitments)) continue;
      try {
        const { persistLpDisclosure } = await import("../services/lpDisclosures/persist");
        await persistLpDisclosure(env, payload, `lp_disclosure:${payload.lp_slug}`);
      } catch (e) {
        console.warn("lpDisclosure persist failed", url, (e as Error).message);
      }
    }

    // Task #3: deal_announcement persist side-effect. Every deal feed
    // adapter (techcrunch, prNewswire, businessWire, …) emits
    // `profile_type === 'deal_announcement'` with a typed DealCandidate
    // in `candidate.data`. Route each through the dedicated persist
    // layer (deal_events + deal_participants + canonical fact writes,
    // idempotent on UNIQUE(dedupe_key)). A persist failure must never
    // block extraction.
    for (const cand of adapterOutcome.result.candidates) {
      if (cand.profile_type !== "deal_announcement") continue;
      const payload = cand.data as unknown as
        import("../services/deals/types").DealCandidate | undefined;
      if (!payload || !payload.company_name_raw || !payload.source_url) continue;
      try {
        const { persistDeal } = await import("../services/deals/persist");
        await persistDeal(env, payload, `deal_feed:${adapterOutcome.used_adapter_id}`);
      } catch (e) {
        console.warn("deal persist failed", url, (e as Error).message);
      }
    }
  }

  // Task #3: International coverage dispatch. After the SiteAdapter
  // pass, consult the IntlAdapter registry (jurisdiction hint > host >
  // suffix > TLD). On a match, run the adapter's pure parsePage against
  // the already-fetched HTML — no second fetch — and append the
  // resulting IntlEntityHit as an extractor candidate so downstream
  // routing surfaces the jurisdictional binding. When the parser
  // returns a hit we also persist it through services/intl/persist
  // (canonical createEntity + insertFact write path). Engine never
  // special-cases any one jurisdiction.
  // Intl dispatch. Failures are surfaced as structured records on the
  // extractor result (so acceptance probes see explicit failures, not
  // silent degradation) but never abort the rest of the extraction —
  // one broken jurisdiction must not blank the whole candidates list.
  {
    const { pickIntlAdapter } = await import("./adapters/intl/registry");
    const intl = pickIntlAdapter(url, opts.intlJurisdictionHint ?? null);
    if (intl) {
      let hit: import("./adapters/intl/types").IntlEntityHit | null = null;
      try {
        hit = intl.parsePage(html, url);
      } catch (e) {
        const msg = (e as Error).message;
        console.error("intl parsePage failed", intl.id, url, msg);
        result.errors = result.errors ?? [];
        result.errors.push({ stage: "intl_parse", adapter_id: intl.id, url, message: msg });
      }
      if (hit) {
        result.candidates.push({
          profile_type: hit.kind === "person" ? "person" : "investor_firm",
          confidence: hit.confidence,
          source: "ai_semantic",
          name: hit.display_name,
          url: hit.url,
          data: { intl_hit: hit, jurisdiction: intl.jurisdiction, adapter_id: intl.id },
        });
        try {
          const { persistIntlEntityFromPage } = await import("../services/intl/persist");
          await persistIntlEntityFromPage(env, intl, html, url);
        } catch (e) {
          const msg = (e as Error).message;
          console.error("intl persist failed", intl.id, url, msg);
          result.errors = result.errors ?? [];
          result.errors.push({ stage: "intl_persist", adapter_id: intl.id, url, message: msg });
        }
      }
    }
  }

  const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Step 1: JSON-LD
  for (const node of parseJsonLd(html)) {
    const type = pickProfileTypeForJsonLd(node);
    result.candidates.push({
      profile_type: type,
      confidence: type ? 0.8 : 0.4,
      source: "json_ld",
      name: nameFromJsonLd(node),
      url,
      data: node,
    });
  }

  // Step 2: Microdata
  for (const md of parseMicrodata(html).slice(0, 8)) {
    result.candidates.push({
      profile_type: null,
      confidence: 0.4,
      source: "microdata",
      name: md.props.name ?? null,
      url,
      data: md.props,
    });
  }

  // Step 3: Open Graph + Twitter Card
  const og = parseOpenGraph(html);
  if (Object.keys(og).length) {
    result.candidates.push({
      profile_type: null,
      confidence: 0.3,
      source: "open_graph",
      name: og["og:site_name"] ?? og["og:title"] ?? null,
      url: og["og:url"] ?? url,
      data: og,
    });
  }

  // Step 4: Readability (always — body text feeds the AI pass + signal scan)
  const bodyText = readabilityText(html);
  if (bodyText) {
    result.candidates.push({
      profile_type: null,
      confidence: 0.2,
      source: "readability",
      name: title || null,
      url,
      data: { text_preview: bodyText.slice(0, 400), bytes: bodyText.length },
    });
  }

  // Step 5: Profile-type matching (deterministic) — uses the registry's
  // detection signals to pick the candidate types for this page.
  const registry = await loadRegistry(env);
  const matched: Array<{ type: ProfileType; confidence: number; fired_signals: string[] }> = [];
  if (opts.profileTypeHint) {
    const hinted = registry.find((t) => t.id === opts.profileTypeHint);
    if (hinted) {
      const tr = testPage(hinted, { url, html });
      matched.push({ type: hinted, confidence: tr.confidence, fired_signals: tr.fired_signals });
    }
  } else {
    for (const t of registry) {
      const tr = testPage(t, { url, html });
      if (tr.matched) matched.push({ type: t, confidence: tr.confidence, fired_signals: tr.fired_signals });
    }
    matched.sort((a, b) => b.confidence - a.confidence);
    matched.splice(3); // keep top-3 candidate types
  }
  for (const m of matched) {
    result.matched_types.push({ type_id: m.type.id, confidence: m.confidence, fired_signals: m.fired_signals });
  }

  // Step 6: AI semantic pass (only when we have a matched type — keeps
  // neurons sane). Run for the top candidate type only.
  const top = matched[0];
  if (top && bodyText) {
    result.used_ai = true;
    const ai = await aiSemanticPass(env, top.type, { url, text: bodyText, title });
    result.ai_error = ai.error;
    if (Object.keys(ai.data).length || ai.confidence > 0) {
      result.candidates.push({
        profile_type: top.type.id,
        confidence: Math.max(ai.confidence, top.confidence * 0.5),
        source: "ai_semantic",
        name: (ai.data.name as string) ?? title ?? null,
        url,
        data: ai.data,
      });
    }
  }

  // Step 7: Page classification — authoritative source of the
  // downstream `route`. classifyPage() already has internal fallback
  // behavior (defaults to {page_type:"other",source:"default"}); if it
  // throws outright we record a deterministic fallback classification
  // with an explicit error signal so misroutes surface in telemetry
  // instead of being silently dropped as "skip".
  let classification: PageClassification;
  try {
    classification = await classifyPage(env, url, html);
  } catch (e) {
    console.warn("crawler.classifyPage threw", (e as Error).message);
    classification = {
      page_type: "other",
      confidence: 0,
      source: "default",
      signals: [`error:${(e as Error).message}`],
    };
  }
  result.classification = classification;
  result.route = routeForPageType(classification.page_type);

  return result;
}
