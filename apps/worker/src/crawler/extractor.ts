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
import { classifyPage, isNewsLike, type PageClassification } from "../services/pageClassifier";

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
  opts: { profileTypeHint?: string } = {},
): Promise<ExtractionResult> {
  const result: ExtractionResult = {
    url, matched_types: [], candidates: [], used_ai: false, ai_error: null,
    classification: null, route: "skip",
  };
  if (!html) return result;

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

  // Step 7: Page classification — decides downstream routing. News /
  // blog / press-release pages go to `news_items` (+ entity mentions);
  // company/team/profile pages flow to the entity persister via the
  // PredicateRouter. `skip` is reserved for directory hubs and unknown
  // pages with no usable signals.
  try {
    const classification = await classifyPage(env, url, html);
    result.classification = classification;
    if (isNewsLike(classification.page_type)) {
      result.route = "news_item";
    } else if (matched.length > 0 || classification.page_type === "profile" || classification.page_type === "team_page" || classification.page_type === "company_home") {
      result.route = "entity";
    } else {
      result.route = "skip";
    }
  } catch (e) {
    // Never let classification failure abort extraction — preview will
    // still surface candidates and matched_types.
    console.warn("crawler.classifyPage failed", (e as Error).message);
  }

  return result;
}
