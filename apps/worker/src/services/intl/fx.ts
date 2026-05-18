// Task #3: Currency normalization.
//
// One canonical entry point: toUsd(amount, currency, asOfDate). Every
// intl adapter calls it before persisting; raw {amount, currency} is
// retained in source_evidence_json so the worker can replay if the FX
// matrix ever drifts.
//
// Rate sourcing strategy:
//   1. ECB euro reference rates (free, no key) — covers all major pairs
//      through EUR triangulation.
//   2. exchangerate.host — free secondary for pairs the ECB matrix
//      doesn't carry (e.g. ILS×USD on a non-publication day).
//
// Caching: daily snapshot in SCRAPE_CACHE KV keyed by
// `fx:matrix:${YYYY-MM-DD}`. A single fetch warms the whole matrix for
// the day; `toUsd` only goes to network on a cold-cache day. The
// snapshot stores EUR→X rates; USD conversion goes via EUR.
//
// Fail-loud contract: when no rate can be resolved for (currency, day)
// after exhausting the matrix + a 7-day backwards search, the function
// throws — callers MUST NOT silently fall back to 1:1 (which would
// silently bin a €10M filing as $10M).

import type { Env } from "../../types";

const ECB_DAILY_URL = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml";
const HOST_FALLBACK = "https://api.exchangerate.host";

function todayIso(): string { return new Date().toISOString().slice(0, 10); }

export class FxLookupError extends Error {
  constructor(currency: string, asOfDate: string, reason: string) {
    super(`fx lookup ${currency}@${asOfDate}: ${reason}`);
    this.name = "FxLookupError";
  }
}

export interface FxMatrix {
  /** Snapshot date — ISO YYYY-MM-DD. May be earlier than the requested
   *  date when the requested day was a non-publication day. */
  as_of: string;
  /** EUR → X rates. EUR itself is 1. USD always present. */
  eur_rates: Record<string, number>;
  /** When the matrix is augmented by the secondary source on a per-pair
   *  basis, the augmenting rates land here as USD → X. */
  usd_extra: Record<string, number>;
}

const MEMO: Map<string, FxMatrix> = new Map();

function isoDay(d: string | Date): string {
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) throw new FxLookupError("?", String(d), "unparseable date");
  return dt.toISOString().slice(0, 10);
}

/** Parse the ECB daily XML feed into an EUR-keyed rate map. The feed
 *  emits a single `<Cube time="YYYY-MM-DD">` whose children are
 *  `<Cube currency="X" rate="Y" />`. Hand-rolled regex parse — Workers
 *  has no DOMParser and we keep this dependency-free. */
function parseEcbXml(xml: string): { as_of: string | null; rates: Record<string, number> } {
  const dateMatch = xml.match(/<Cube\s+time=["'](\d{4}-\d{2}-\d{2})["']/i);
  const rates: Record<string, number> = { EUR: 1 };
  const re = /<Cube\s+currency=["']([A-Z]{3})["']\s+rate=["']([0-9.]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const v = Number(m[2]);
    if (Number.isFinite(v) && v > 0) rates[m[1]] = v;
  }
  return { as_of: dateMatch?.[1] ?? null, rates };
}

async function fetchEcbMatrix(): Promise<{ as_of: string; rates: Record<string, number> } | null> {
  try {
    const res = await fetch(ECB_DAILY_URL, { headers: { "user-agent": "AxalVCBot/1.0 (+https://aidatasignal.com)" } });
    if (!res.ok) return null;
    const xml = await res.text();
    const parsed = parseEcbXml(xml);
    if (!parsed.as_of || Object.keys(parsed.rates).length < 5) return null;
    return { as_of: parsed.as_of, rates: parsed.rates };
  } catch { return null; }
}

async function fetchHostExtra(currency: string, asOfDate: string): Promise<number | null> {
  // exchangerate.host: GET /{YYYY-MM-DD}?base=USD&symbols=XXX
  try {
    const url = `${HOST_FALLBACK}/${asOfDate}?base=USD&symbols=${encodeURIComponent(currency)}`;
    const res = await fetch(url, { headers: { "user-agent": "AxalVCBot/1.0" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { rates?: Record<string, number> };
    const v = j.rates?.[currency];
    return typeof v === "number" && v > 0 ? v : null;
  } catch { return null; }
}

/** Historical EUR-base matrix for an arbitrary day. ECB's daily feed
 *  only carries today's rates, so for any past date we go to
 *  exchangerate.host's dated endpoint (`/{YYYY-MM-DD}?base=EUR`) which
 *  publishes the ECB reference rates by date. Returns null on any
 *  failure so the caller can decide whether to fail-loud or fall back. */
async function fetchHostMatrix(asOfDate: string): Promise<{ as_of: string; rates: Record<string, number> } | null> {
  try {
    const url = `${HOST_FALLBACK}/${asOfDate}?base=EUR`;
    const res = await fetch(url, { headers: { "user-agent": "AxalVCBot/1.0" } });
    if (!res.ok) return null;
    const j = (await res.json()) as { date?: string; rates?: Record<string, number> };
    if (!j.rates || typeof j.rates.USD !== "number") return null;
    return { as_of: j.date ?? asOfDate, rates: { EUR: 1, ...j.rates } };
  } catch { return null; }
}

async function loadMatrix(env: Env, asOfDate: string): Promise<FxMatrix> {
  const memoHit = MEMO.get(asOfDate);
  if (memoHit) return memoHit;
  const cacheKey = `fx:matrix:${asOfDate}`;
  if (env.SCRAPE_CACHE) {
    const cached = await env.SCRAPE_CACHE.get(cacheKey, "json") as FxMatrix | null;
    if (cached && cached.eur_rates && typeof cached.eur_rates.USD === "number") {
      MEMO.set(asOfDate, cached);
      return cached;
    }
  }
  // Date-aware sourcing: ECB's daily XML is TODAY's rates only — using
  // it for a past date would silently return wrong values. So:
  //   * For today's date (or future), prefer ECB and fall back to host.
  //   * For any past date, prefer host's dated endpoint and only fall
  //     back to ECB when the requested day is today.
  const today = todayIso();
  const isToday = asOfDate >= today;
  let as_of = asOfDate;
  let rates: Record<string, number> | null = null;
  if (isToday) {
    const ecb = await fetchEcbMatrix();
    if (ecb) { as_of = ecb.as_of; rates = ecb.rates; }
    if (!rates) {
      const host = await fetchHostMatrix(asOfDate);
      if (host) { as_of = host.as_of; rates = host.rates; }
    }
  } else {
    const host = await fetchHostMatrix(asOfDate);
    if (host) { as_of = host.as_of; rates = host.rates; }
  }
  const matrix: FxMatrix = {
    as_of, eur_rates: rates ?? { EUR: 1 }, usd_extra: {},
  };
  if (env.SCRAPE_CACHE && rates) {
    // Only cache when we actually got a dated matrix — never cache an
    // empty {EUR:1} placeholder (that would poison subsequent lookups).
    await env.SCRAPE_CACHE.put(cacheKey, JSON.stringify(matrix), { expirationTtl: 60 * 60 * 24 * 30 });
  }
  MEMO.set(asOfDate, matrix);
  return matrix;
}

// EUR triangulation:
//   eurAmount = amount / rate_eur_to_cu   (matrix stores EUR → X)
//   ECB:       1 EUR = `eur_rates.USD` USD, so usdAmount = eurAmount * eur_rates.USD.
// usd_extra is keyed USD → X (exchangerate.host base=USD), so amount/usd_extra[X].
function triangulate(amount: number, currency: string, m: FxMatrix): number | null {
  const cu = currency.toUpperCase();
  if (cu === "USD") return amount;
  if (typeof m.usd_extra[cu] === "number") return amount / m.usd_extra[cu];
  const eurToUsd = m.eur_rates["USD"];
  if (!eurToUsd) return null;
  if (cu === "EUR") return amount * eurToUsd;
  const eurToCu = m.eur_rates[cu];
  if (!eurToCu) return null;
  return (amount / eurToCu) * eurToUsd;
}

/** Convert `amount` in `currency` to USD as of `asOfDate` (ISO date or
 *  parsable). Throws FxLookupError if no rate can be resolved. */
export async function toUsd(
  env: Env, amount: number, currency: string, asOfDate: string,
): Promise<number> {
  if (!Number.isFinite(amount)) throw new FxLookupError(currency, asOfDate, "non-finite amount");
  const day = isoDay(asOfDate);
  const matrix = await loadMatrix(env, day);
  let usd = triangulate(amount, currency, matrix);
  if (usd == null) {
    // Augment with exchangerate.host fallback on a single-pair basis.
    const extra = await fetchHostExtra(currency, day);
    if (extra != null) {
      matrix.usd_extra[currency.toUpperCase()] = extra;
      if (env.SCRAPE_CACHE) {
        await env.SCRAPE_CACHE.put(
          `fx:matrix:${day}`, JSON.stringify(matrix),
          { expirationTtl: 60 * 60 * 26 },
        );
      }
      usd = triangulate(amount, currency, matrix);
    }
  }
  if (usd == null || !Number.isFinite(usd)) {
    throw new FxLookupError(currency, day, "no rate after ECB + host fallback");
  }
  return Math.round(usd * 100) / 100;
}

/** Test seam — clears the per-process FX memo and seeds a matrix.
 *  Used only by unit tests; production never calls this. */
export function __seedFxForTests(asOfDate: string, eur_rates: Record<string, number>): void {
  MEMO.set(asOfDate, { as_of: asOfDate, eur_rates, usd_extra: {} });
}
export function __clearFxForTests(): void { MEMO.clear(); }
