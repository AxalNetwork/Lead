// Task #3: Shared helpers for deal-feed adapters.
//
// All press-wire (PR Newswire, BusinessWire, GlobeNewswire, AccessWire,
// Cision) and tech-press (TechCrunch, VentureBeat, Crunchbase News,
// Axios Pro Rata, …) sources serve RSS / Atom feeds. The feed payload
// is what the crawler engine hands us as `html` — we parse it with a
// regex-based item splitter (no DOM in workerd), run a fast heuristic
// extractor over each item's title + description, and emit one
// `profile_type: "deal_announcement"` candidate per item.
//
// The persist layer (services/deals/persist.ts) is the only writer. The
// AI DealExtractor (ai/dealExtractor.ts) is an optional second pass
// invoked from the persist side-effect when the heuristic confidence
// is below an AI threshold — kept out of the adapter so the adapter
// stays pure and synchronous (the SiteAdapter contract).

import type { AdapterResult, AdapterCandidate } from "../types";
import type {
  DealCandidate, DealRoundName, DealSourceType, DealEventType,
} from "../../../services/deals/types";

// ---- RSS / Atom parsing -------------------------------------------------

export interface RawFeedItem {
  title: string;
  link: string;
  description: string;
  pubDate: string | null;     // ISO if parseable
  guid: string | null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim());
}

function pickFirst(item: string, tags: string[]): string {
  for (const t of tags) {
    const m = item.match(new RegExp(`<${t}\\b[^>]*>([\\s\\S]*?)<\\/${t}>`, "i"));
    if (m) return decodeEntities(m[1]).trim();
  }
  return "";
}

function pickLink(item: string): string {
  // RSS <link>...</link> OR Atom <link href="..." />
  const inner = item.match(/<link\b[^>]*>([\s\S]*?)<\/link>/i)?.[1]?.trim();
  if (inner && /^https?:\/\//i.test(inner)) return decodeEntities(inner);
  const attr = item.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i)?.[1];
  if (attr) return decodeEntities(attr);
  return "";
}

function toIso(d: string | null | undefined): string | null {
  if (!d) return null;
  const t = new Date(d.trim());
  if (isNaN(t.getTime())) return null;
  return t.toISOString();
}

/**
 * Parse an RSS 2.0 or Atom 1.0 feed body. Tolerant on partially-malformed
 * feeds — returns whatever items it can extract.
 */
export function parseFeed(body: string): RawFeedItem[] {
  if (!body) return [];
  const out: RawFeedItem[] = [];
  // RSS <item>…</item> or Atom <entry>…</entry>
  const re = /<(item|entry)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    const inner = m[2];
    const title = stripTags(pickFirst(inner, ["title"]));
    const link = pickLink(inner);
    const desc = stripTags(pickFirst(inner, ["description", "content:encoded", "summary", "content"]));
    const pubDate = toIso(pickFirst(inner, ["pubDate", "published", "updated", "dc:date"]));
    const guid = pickFirst(inner, ["guid", "id"]) || null;
    if (!title && !desc) continue;
    out.push({ title, link, description: desc, pubDate, guid });
    if (out.length >= 200) break;
  }
  return out;
}

// ---- Heuristic deal extractor ------------------------------------------
//
// Cheap regex extraction over the item's title + first ~600 chars of
// description. Covers ~70% of standard press-wire headlines:
//   "Acme raises $42M Series B led by Sequoia"
//   "Acme closes $120 million Series C funding round"
//   "Acme secures €50M in seed funding from Index Ventures and Atomico"
//   "BigCo acquires SmallCo for $1.2 billion"
//   "Acme files for IPO"
//
// On miss / low confidence the persist side-effect can invoke the AI
// DealExtractor (ai/dealExtractor.ts) — heuristic is the fast path
// that keeps the AI neuron cap intact.

const AMOUNT_RE = /(?:USD\s*|US\$\s*|[$€£])\s*([0-9]+(?:\.[0-9]+)?)\s*(million|billion|thousand|m|b|k|mm|bn)?\b/i;
const ROUND_RE = /\b(pre[\s-]?seed|seed|series\s+[A-K]|bridge|extension|pipe|growth)\b/i;
const EVENT_HINT: Array<{ re: RegExp; t: DealEventType }> = [
  { re: /\b(acquires|acquisition|to acquire|buy[s]?\s+|purchases|takes over)\b/i, t: "acquisition" },
  { re: /\b(merger|merges with|to merge)\b/i, t: "merger" },
  { re: /\b(files for ipo|ipo[s]?|initial public offering|debuts on (nyse|nasdaq))\b/i, t: "ipo" },
  { re: /\b(spin[\s-]?out|spinout|spin[\s-]?off|spinoff)\b/i, t: "spinout" },
  { re: /\b(secondary (sale|offering)|tender offer)\b/i, t: "secondary" },
  { re: /\b(recap(italization)?|restructur(es|ing))\b/i, t: "recapitalization" },
  { re: /\b(chapter\s+11|files for bankruptcy|bankruptcy)\b/i, t: "bankruptcy" },
  { re: /\b(raises|raised|closes|closed|secures|secured|funding|round)\b/i, t: "funding_round" },
];
const LED_BY_RE = /\bled by\s+([A-Z][A-Za-z0-9 .,&'\-]+?)(?=[.,;]|\s+(?:with|and|alongside|joined)\b|$)/;
const WITH_PARTICIPATION_RE = /\b(?:with (?:participation|backing)? from|alongside|joined by|including)\s+([A-Z][A-Za-z0-9 .,&'\-]+?)(?=[.,;]|$)/i;
const TO_ACQUIRE_RE = /^([A-Z][A-Za-z0-9 .,&'\-]+?)\s+(?:to acquire|acquires|completes acquisition of)\s+([A-Z][A-Za-z0-9 .,&'\-]+?)(?=\s+(?:for|in|at)\s+\$|\s*[.,;:]|$)/;

function parseAmountUsd(raw: string): { amount: number | null; raw: string | null } {
  const m = AMOUNT_RE.exec(raw);
  if (!m) return { amount: null, raw: null };
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return { amount: null, raw: m[0] };
  const unit = (m[2] ?? "").toLowerCase();
  let mult = 1;
  if (unit === "billion" || unit === "b" || unit === "bn") mult = 1_000_000_000;
  else if (unit === "million" || unit === "m" || unit === "mm") mult = 1_000_000;
  else if (unit === "thousand" || unit === "k") mult = 1_000;
  // Non-USD currency detected — flag as raw only; persist hierarchy will
  // pick the USD value from a corroborating source if any.
  const isNonUsd = /^[€£]/.test(m[0].trim());
  return { amount: isNonUsd ? null : Math.round(n * mult), raw: m[0].trim() };
}

function detectEventType(text: string): DealEventType {
  for (const h of EVENT_HINT) if (h.re.test(text)) return h.t;
  return "funding_round";
}

function normalizeRound(raw: string | null): DealRoundName | null {
  if (!raw) return null;
  const s = raw.trim().toLowerCase().replace(/[\s-]+/g, " ");
  if (/^pre[ -]?seed/.test(s) || s === "preseed") return "Pre-Seed";
  if (s === "seed") return "Seed";
  if (s === "bridge") return "Bridge";
  if (s === "extension") return "Extension";
  if (s === "pipe") return "PIPE";
  const ser = /^series ([a-k])/i.exec(s);
  if (ser) return `Series ${ser[1].toUpperCase()}` as DealRoundName;
  return null;
}

/** Split a list of investor names connected by commas + "and". */
function splitInvestors(s: string): string[] {
  return s.replace(/\s+and\s+/gi, ",")
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 1 && p.length < 80 && /^[A-Z]/.test(p))
    // Guard against obvious non-investors (trailing prose words).
    .filter((p) => !/^(today|that|which|after|including|round|funding)\b/i.test(p));
}

/**
 * Headline-extractor. Returns a DealCandidate when the title is parseable
 * enough to clear MIN_CONFIDENCE; returns null otherwise (caller may
 * invoke the AI extractor as fallback).
 *
 * Exported for the adapter tests.
 */
export function extractDealFromHeadline(
  title: string,
  description: string,
  url: string,
  pubDate: string | null,
  sourceType: DealSourceType,
): DealCandidate | null {
  const blob = `${title}. ${description}`.slice(0, 1200);
  if (!title || title.length < 8) return null;

  const event_type = detectEventType(blob);

  let company_name_raw = "";
  let acquirer = "";
  const acq = TO_ACQUIRE_RE.exec(title);
  if (event_type === "acquisition" && acq) {
    acquirer = acq[1].trim();
    company_name_raw = acq[2].trim();
  } else {
    // For funding rounds, the company name is typically the title prefix
    // ending at "raises|closes|secures|announces".
    const m = /^([A-Z][A-Za-z0-9 .,&'\-]+?)\s+(?:raises|raised|closes|closed|secures|secured|announces|announced|lands|nets|bags|picks up|completes|gets)\b/.exec(title);
    if (m) company_name_raw = m[1].trim();
    else {
      // Fallback: take everything before the amount or "—" / "|" / ":" separator.
      const sepIdx = title.search(/\s+[\-—|:]\s+/);
      company_name_raw = (sepIdx > 0 ? title.slice(0, sepIdx) : title.split(/\s+(?:raises|to|with|in|for|completes|files)\b/i)[0]).trim();
    }
  }
  if (!company_name_raw || company_name_raw.length < 2 || company_name_raw.length > 120) return null;

  const { amount, raw: amount_raw } = parseAmountUsd(blob);
  const round = normalizeRound(ROUND_RE.exec(blob)?.[1] ?? null);

  const leads: string[] = [];
  const participants: string[] = [];
  const ledBy = LED_BY_RE.exec(blob);
  if (ledBy) leads.push(...splitInvestors(ledBy[1]));
  const withPart = WITH_PARTICIPATION_RE.exec(blob);
  if (withPart) participants.push(...splitInvestors(withPart[1]));
  // For acquisitions: the acquirer is the "investor" / counterparty.
  if (event_type === "acquisition" && acquirer) leads.push(acquirer);

  // Confidence model: company name parsed + (round || amount) is the
  // floor for a deal we'll persist. Bare company-name-only is too weak.
  let conf = 0;
  if (company_name_raw) conf += 0.3;
  if (amount != null) conf += 0.25;
  if (round) conf += 0.2;
  if (leads.length || participants.length) conf += 0.15;
  if (event_type !== "funding_round") conf += 0.05;
  if (pubDate) conf += 0.05;

  if (conf < 0.5) return null;

  return {
    event_type,
    company_name_raw,
    company_website: null,
    round_name: round,
    amount_usd: amount,
    amount_raw,
    valuation_usd: null,
    valuation_type: "unknown",
    lead_investors: leads.slice(0, 8),
    participating_investors: participants.slice(0, 16),
    announcement_date: pubDate ? pubDate.slice(0, 10) : null,
    closing_date: null,
    sector_tags: [],
    stage_tags: round ? [round] : [],
    geography: null,
    use_of_proceeds: null,
    source_url: url,
    source_type: sourceType,
    source_published_at: pubDate,
    confidence: Math.min(0.95, conf),
  };
}

// ---- Adapter factory ---------------------------------------------------

/** Build an AdapterResult from a parsed RSS/Atom body. Pure: never
 *  touches the network or DB. */
export function buildDealAdapterResult(
  adapter_id: string,
  feedBody: string,
  feedUrl: string,
  sourceType: DealSourceType,
): AdapterResult {
  const items = parseFeed(feedBody);
  const candidates: AdapterCandidate[] = [];
  const child_urls: string[] = [];
  for (const it of items) {
    const cand = extractDealFromHeadline(
      it.title, it.description, it.link || feedUrl, it.pubDate, sourceType,
    );
    if (!cand) {
      // Still surface the article URL as a child so the engine can
      // re-crawl the article body and re-run the AI extractor.
      if (it.link) child_urls.push(it.link);
      continue;
    }
    candidates.push({
      profile_type: "deal_announcement",
      confidence: cand.confidence,
      name: cand.company_name_raw,
      url: cand.source_url,
      data: cand as unknown as Record<string, unknown>,
    });
    if (it.link) child_urls.push(it.link);
  }
  const conf = candidates.length
    ? Math.max(...candidates.map((c) => c.confidence))
    : 0.1;
  return {
    adapter_id,
    confidence: conf,
    candidates,
    child_urls: child_urls.slice(0, 100),
    notes: { items: items.length, deals: candidates.length },
  };
}
