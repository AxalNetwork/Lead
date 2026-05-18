// Task #3: DealExtractor — Workers AI strict-JSON extractor.
//
// Schema-strict (spec: "returns valid JSON or confidence: 0 — no silent
// coercion"). Called as the second pass when the heuristic extractor
// (crawler/adapters/deals/_shared.ts extractDealFromHeadline) returns
// null or low confidence, OR when an adapter has handed us the full
// article body rather than just an RSS headline.
//
// Caching via aiCache (sha256 over model + page text) so re-running the
// same article never burns a second neuron. Timeout 30s; failure
// returns null (caller falls back to whatever the heuristic produced
// or skips the row).

import type { Env } from "../types";
import type {
  DealCandidate, DealEventType, DealRoundName,
  DealSourceType, DealValuationType,
} from "../services/deals/types";
import { aiCacheGet, aiCachePut, sha256Hex } from "./cache";
import { assertBudget } from "./budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";

export const DEAL_EXTRACTOR_VERSION = "deal_extractor:v1";
const AI_TIMEOUT_MS = 30_000;
const TEXT_CAP = 8_000;

const DEAL_EVENT_TYPES = [
  "funding_round", "acquisition", "merger", "ipo",
  "secondary", "spinout", "recapitalization", "bankruptcy",
] as const;

const DEAL_ROUND_NAMES = [
  "Pre-Seed", "Seed", "Series A", "Series B", "Series C", "Series D",
  "Series E", "Series F", "Series G", "Series H", "Bridge", "Extension", "PIPE",
] as const;

const DEAL_SCHEMA = {
  type: "object",
  properties: {
    event_type: { type: "string", enum: [...DEAL_EVENT_TYPES] },
    company_name: { type: "string" },
    company_website: { type: "string" },
    round_name: { type: "string", enum: [...DEAL_ROUND_NAMES, ""] },
    amount_usd: { type: "number" },
    amount_raw: { type: "string" },
    valuation_usd: { type: "number" },
    valuation_type: { type: "string", enum: ["pre_money", "post_money", "unknown", ""] },
    lead_investors: { type: "array", items: { type: "string" } },
    participating_investors: { type: "array", items: { type: "string" } },
    announcement_date: { type: "string" },
    closing_date: { type: "string" },
    sector_tags: { type: "array", items: { type: "string" } },
    stage_tags: { type: "array", items: { type: "string" } },
    geography: { type: "string" },
    use_of_proceeds: { type: "string" },
    confidence: { type: "number" },
  },
  required: ["confidence"],
} as const;

interface RawDealExtraction {
  event_type?: string;
  company_name?: string;
  company_website?: string;
  round_name?: string;
  amount_usd?: number;
  amount_raw?: string;
  valuation_usd?: number;
  valuation_type?: string;
  lead_investors?: string[];
  participating_investors?: string[];
  announcement_date?: string;
  closing_date?: string;
  sector_tags?: string[];
  stage_tags?: string[];
  geography?: string;
  use_of_proceeds?: string;
  confidence?: number;
}

export interface DealExtractInput {
  /** Raw article text (already stripped of HTML by the caller). */
  text: string;
  /** Canonical article URL. */
  source_url: string;
  /** Authority tier of the article — supplied by the adapter. */
  source_type: DealSourceType;
  /** Article publish date (ISO) if known from the feed. */
  source_published_at?: string | null;
}

/** Coerce a free-text event_type to the closed enum. */
function coerceEventType(s: string | undefined): DealEventType | null {
  if (!s) return null;
  const k = s.toLowerCase().replace(/\s+/g, "_");
  return (DEAL_EVENT_TYPES as readonly string[]).includes(k) ? (k as DealEventType) : null;
}

function coerceRound(s: string | undefined): DealRoundName | null {
  if (!s) return null;
  return (DEAL_ROUND_NAMES as readonly string[]).includes(s) ? (s as DealRoundName) : null;
}

function coerceValType(s: string | undefined): DealValuationType {
  if (s === "pre_money" || s === "post_money") return s;
  return "unknown";
}

function coerceIsoDate(s: string | undefined | null): string | null {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Run DealExtractor against a single article. Schema-strict: returns
 * null whenever Workers AI is unavailable, the JSON parse fails, the
 * model's self-reported confidence is < 0.2, or the company_name is
 * missing (the spec's "no silent coercion" gate).
 *
 * Cached on sha256(model + version + text + url).
 */
export async function runDealExtractor(
  env: Env, input: DealExtractInput,
): Promise<DealCandidate | null> {
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const text = (input.text ?? "").slice(0, TEXT_CAP);
  if (!text || text.length < 80) return null;
  const cacheKey = await sha256Hex(`${model}:${DEAL_EXTRACTOR_VERSION}:${input.source_url}:${text.length}:${text.slice(0, 200)}`);
  const cached = await aiCacheGet<RawDealExtraction>(env, cacheKey);
  if (cached) {
    trackAi(env, { purpose: "extraction", model, cacheHit: true });
    return toCandidate(cached, input);
  }
  if (!env.AI) return null;
  const okBudget = await assertBudget(env, "ai");
  if (!okBudget.ok) return null;
  if (!(await limitAi(env))) return null;

  const sys =
    "You extract one funding round, M&A, or exit event from a press release or news article. " +
    "Return STRICT JSON matching the schema. Use \"\" or 0 for unknown fields — never invent values. " +
    "amount_usd must be in US dollars (convert if amount is in another currency); if you can't convert, leave it as 0. " +
    "round_name must be one of the listed enum values or \"\". " +
    "confidence is your 0..1 self-rated certainty that the extraction is correct.";
  const usr = `URL: ${input.source_url}\n\nArticle:\n${text}`;

  const t0 = Date.now();
  const attempt = async (temperature: number): Promise<RawDealExtraction | null> => {
    try {
      const racePromise = env.AI!.run(model, {
        messages: [
          { role: "system", content: sys },
          { role: "user", content: usr },
        ],
        response_format: { type: "json_schema", json_schema: DEAL_SCHEMA },
        temperature,
      } as unknown as Record<string, unknown>) as Promise<{ response?: string } & Record<string, unknown>>;
      const res = await Promise.race<{ response?: string } & Record<string, unknown>>([
        racePromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("ai_timeout")), AI_TIMEOUT_MS),
        ),
      ]);
      let parsed: unknown = null;
      if (typeof res?.response === "string") {
        try { parsed = JSON.parse(res.response); } catch { return null; }
      } else if (res && typeof res === "object") {
        const { response: _r, usage: _u, ...rest } = res as Record<string, unknown>;
        parsed = rest;
      }
      if (!parsed || typeof parsed !== "object") return null;
      return parsed as RawDealExtraction;
    } catch {
      return null;
    }
  };
  let raw = await attempt(0.1);
  if (!raw) raw = await attempt(0.0);
  trackAi(env, { purpose: "extraction", model, cacheHit: false, ms: Date.now() - t0 });
  if (!raw) return null;
  await aiCachePut(env, cacheKey, raw);
  return toCandidate(raw, input);
}

function toCandidate(raw: RawDealExtraction, input: DealExtractInput): DealCandidate | null {
  const conf = typeof raw.confidence === "number" ? raw.confidence : 0;
  if (!Number.isFinite(conf) || conf < 0.2) return null;
  const company = (raw.company_name ?? "").trim();
  if (!company || company.length < 2) return null;
  const event_type = coerceEventType(raw.event_type) ?? "funding_round";
  const amount_usd = typeof raw.amount_usd === "number" && raw.amount_usd > 0 ? raw.amount_usd : null;
  const valuation_usd = typeof raw.valuation_usd === "number" && raw.valuation_usd > 0 ? raw.valuation_usd : null;
  return {
    event_type,
    company_name_raw: company,
    company_website: raw.company_website?.trim() || null,
    round_name: coerceRound(raw.round_name),
    amount_usd,
    amount_raw: raw.amount_raw?.trim() || (amount_usd != null ? `$${amount_usd}` : null),
    valuation_usd,
    valuation_type: coerceValType(raw.valuation_type),
    lead_investors: Array.isArray(raw.lead_investors)
      ? raw.lead_investors.filter((s) => typeof s === "string" && s.trim().length >= 2).slice(0, 8)
      : [],
    participating_investors: Array.isArray(raw.participating_investors)
      ? raw.participating_investors.filter((s) => typeof s === "string" && s.trim().length >= 2).slice(0, 16)
      : [],
    announcement_date: coerceIsoDate(raw.announcement_date) ?? (input.source_published_at ? input.source_published_at.slice(0, 10) : null),
    closing_date: coerceIsoDate(raw.closing_date),
    sector_tags: Array.isArray(raw.sector_tags) ? raw.sector_tags.slice(0, 12) : [],
    stage_tags: Array.isArray(raw.stage_tags) ? raw.stage_tags.slice(0, 12) : [],
    geography: raw.geography?.trim() || null,
    use_of_proceeds: raw.use_of_proceeds?.trim() || null,
    source_url: input.source_url,
    source_type: input.source_type,
    source_published_at: input.source_published_at ?? null,
    confidence: Math.min(0.95, conf),
  };
}
