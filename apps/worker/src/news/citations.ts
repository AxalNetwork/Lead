// Task #2: Fact citation extraction + verified-score recompute.
//
// For each entity mentioned in a news_item we ask the LLM to extract
// claims as a strict JSON array of {predicate, value, quote}. Each claim
// becomes a fact_citation tied to an existing fact (when found) or a new
// fact (when the predicate/value is novel). Contradicting values trigger
// `contradicts=1` AND insert a competing fact with source_kind='news'.
//
// After every batch of citations we recompute `facts.verified_score` for
// the affected facts using the spec formula.

import type { Env } from "../types";
import type { NewsItemRow, MentionResolved } from "./enrich";
import { getReputability, REPUTABILITY_DEFAULT } from "./reputability";

const SUPPORTED_PREDICATES = [
  "employer", "title", "role", "check_size_min_usd", "check_size_max_usd",
  "investment", "allegation", "award", "location", "hq", "founded",
  "fund_aum_usd", "event", "sector", "stage", "board_member", "founder_of",
] as const;

const CLAIM_PROMPT = `You extract factual claims about ONE subject from a news article excerpt.
Return ONLY a strict JSON array, no prose. Each item:
{"predicate":"employer|title|role|check_size_min_usd|check_size_max_usd|investment|allegation|award|location|hq|founded|fund_aum_usd|event|sector|stage|board_member|founder_of",
 "value":"<short string or number>",
 "quote":"<exact sentence from the article supporting the claim, max 240 chars>"}
Rules:
- Only emit claims the article ACTUALLY states about the subject.
- Skip rumors, hypotheticals, or generic background.
- 'value' must be the concrete attribute (e.g. "Andreessen Horowitz" for employer; "5000000" for check_size).
- Max 8 items. If nothing is claimed about the subject, return [].`;

interface ClaimRaw { predicate?: string; value?: unknown; quote?: string }
interface Claim { predicate: string; value_text: string | null; value_number: number | null; quote: string }

function isSupportedPredicate(p: string): boolean {
  return (SUPPORTED_PREDICATES as readonly string[]).includes(p);
}

export async function extractClaims(env: Env, subjectName: string, articleText: string): Promise<Claim[]> {
  if (!env.AI || !articleText.trim()) return [];
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  try {
    const res = (await env.AI.run(model, {
      messages: [
        { role: "system", content: CLAIM_PROMPT },
        { role: "user", content: `SUBJECT: ${subjectName}\n\nARTICLE:\n${articleText.slice(0, 5000)}` },
      ],
      max_tokens: 640,
      temperature: 0.1,
    })) as { response?: string } | string;
    const out = typeof res === "string" ? res : res?.response ?? "";
    const m = out.match(/\[[\s\S]*\]/);
    if (!m) return [];
    const arr = JSON.parse(m[0]) as ClaimRaw[];
    return arr.filter((c) => c && typeof c.predicate === "string" && isSupportedPredicate(c.predicate))
      .slice(0, 8)
      .map((c) => {
        const raw = c.value;
        let value_text: string | null = null;
        let value_number: number | null = null;
        if (typeof raw === "number" && Number.isFinite(raw)) value_number = raw;
        else if (typeof raw === "string") {
          value_text = raw.trim().slice(0, 240);
          const n = Number(raw.replace(/[, $]/g, ""));
          if (Number.isFinite(n) && /\d/.test(raw)) value_number = n;
        }
        return { predicate: c.predicate!, value_text, value_number, quote: (c.quote ?? "").trim().slice(0, 240) };
      })
      .filter((c) => c.value_text !== null || c.value_number !== null);
  } catch { return []; }
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Returns true if the existing fact's value matches the claim within a
// loose threshold (numbers: 5% delta; strings: case-insensitive equality
// or substring overlap).
function valuesAgree(fact: { value_text: string | null; value_number: number | null }, claim: Claim): boolean {
  if (claim.value_number !== null && fact.value_number !== null) {
    if (fact.value_number === 0) return claim.value_number === 0;
    return Math.abs(claim.value_number - fact.value_number) / Math.max(1, Math.abs(fact.value_number)) <= 0.05;
  }
  if (claim.value_text && fact.value_text) {
    const a = fact.value_text.toLowerCase(); const b = claim.value_text.toLowerCase();
    if (a === b) return true;
    if (a.includes(b) || b.includes(a)) return true;
  }
  return false;
}

// Persist citations for one mention. Returns the list of (fact_id, contradicts)
// tuples actually written so the caller can recompute verified_score.
export async function persistCitationsForMention(
  env: Env,
  newsItemId: string,
  entityId: string,
  evidence_url: string,
  claims: Claim[],
): Promise<Array<{ fact_id: string; contradicts: 0 | 1 }>> {
  const touched: Array<{ fact_id: string; contradicts: 0 | 1 }> = [];

  for (const claim of claims) {
    // Find existing CURRENT fact for this (entity, predicate).
    const existing = await env.DB.prepare(
      `SELECT id, value_text, value_number FROM facts
        WHERE entity_id = ? AND predicate = ? AND is_current = 1
        ORDER BY confidence DESC LIMIT 1`,
    ).bind(entityId, claim.predicate).first<{ id: string; value_text: string | null; value_number: number | null }>();

    // Build the per-claim mutation set and commit it atomically via DB.batch
    // so a mid-claim failure leaves no partial fact/citation residue.
    const stmts: D1PreparedStatement[] = [];
    let factId: string;
    let contradicts: 0 | 1 = 0;

    if (existing && valuesAgree(existing, claim)) {
      factId = existing.id;
    } else if (existing) {
      // Contradicting evidence: cite the prior fact as contradicted AND
      // insert a competing new fact (supported by this article).
      stmts.push(citationStmt(env, existing.id, newsItemId, claim.quote, 1));
      const built = await buildFactInsert(env, entityId, claim, evidence_url);
      factId = built.id;
      if (built.stmt) stmts.push(built.stmt);
      touched.push({ fact_id: existing.id, contradicts: 1 });
    } else {
      const built = await buildFactInsert(env, entityId, claim, evidence_url);
      factId = built.id;
      if (built.stmt) stmts.push(built.stmt);
    }
    stmts.push(citationStmt(env, factId, newsItemId, claim.quote, contradicts));
    try {
      await env.DB.batch(stmts);
    } catch (e) {
      // Only the facts(hash) UNIQUE collision is recoverable — every other
      // failure must surface so the caller can record it in result.errors
      // rather than silently writing a citation against a possibly-missing
      // fact row.
      const msg = (e as Error).message || "";
      const isHashCollision = /UNIQUE/i.test(msg) && /facts/i.test(msg);
      if (!isHashCollision) throw e;
      const built = await buildFactInsert(env, entityId, claim, evidence_url);
      if (!built.id) throw e;
      await env.DB.batch([citationStmt(env, built.id, newsItemId, claim.quote, contradicts)]);
      factId = built.id;
    }
    touched.push({ fact_id: factId, contradicts });
  }
  return touched;
}

async function buildFactInsert(env: Env, entityId: string, claim: Claim, evidence_url: string): Promise<{ id: string; stmt: D1PreparedStatement | null }> {
  const hash = await sha256Hex(`${entityId}|${claim.predicate}|${claim.value_text ?? claim.value_number}|news|${evidence_url}`);
  const existing = await env.DB.prepare(`SELECT id FROM facts WHERE hash = ? LIMIT 1`).bind(hash).first<{ id: string }>();
  if (existing?.id) return { id: existing.id, stmt: null };
  const id = crypto.randomUUID();
  const stmt = env.DB.prepare(
    `INSERT INTO facts(id, entity_id, predicate, value_text, value_number, source_kind, source, evidence_url, confidence, hash, is_current)
     VALUES(?, ?, ?, ?, ?, 'news', 'news.ingest', ?, 0.6, ?, 1)`,
  ).bind(id, entityId, claim.predicate, claim.value_text, claim.value_number, evidence_url, hash);
  return { id, stmt };
}

function citationStmt(env: Env, factId: string, newsItemId: string, quote: string, contradicts: 0 | 1): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT OR IGNORE INTO fact_citations(id, fact_id, news_item_id, quote, contradicts)
     VALUES(?, ?, ?, ?, ?)`,
  ).bind(crypto.randomUUID(), factId, newsItemId, quote.slice(0, 500), contradicts);
}

// Recompute facts.verified_score per the Task #2 formula:
//   clamp(0,1,
//     0.30 * count_distinct_sources_above_0.7
//   + 0.20 * has_primary_source
//   + 0.20 * has_government_source
//   + 0.15 * archive_url_present
//   + 0.10 * recency_score
//   + 0.05 * positive_sentiment_count
//   - 0.10 * contradicting_count
//   )
// Wikipedia facts get a flat +0.15 bonus (applied via wikipediaXref.ts at write time).
export async function recomputeVerifiedScore(env: Env, factId: string): Promise<number> {
  const rows = await env.DB.prepare(
    `SELECT fc.contradicts, ni.host, ni.archive_url, ni.published_at, ni.sentiment, ni.source_reputability
       FROM fact_citations fc
       JOIN news_items ni ON ni.id = fc.news_item_id
      WHERE fc.fact_id = ?`,
  ).bind(factId).all<{ contradicts: number; host: string; archive_url: string | null; published_at: string | null; sentiment: number | null; source_reputability: number }>();

  const hostSet = new Set<string>();
  let hasPrimary = 0;
  let hasGov = 0;
  let archiveCount = 0;
  let recencyMax = 0;
  let positiveSent = 0;
  let contradicting = 0;
  const now = Date.now();
  for (const r of rows.results ?? []) {
    if (r.source_reputability >= 0.7) hostSet.add(r.host);
    if (r.source_reputability >= 0.9) hasPrimary = 1;
    const rep = await getReputability(env, r.host);
    if (rep.tier === "regulator") hasGov = 1;
    if (r.archive_url) archiveCount++;
    if (r.sentiment !== null && r.sentiment > 0.2) positiveSent++;
    if (r.contradicts === 1) contradicting++;
    if (r.published_at) {
      const ts = Date.parse(r.published_at);
      if (Number.isFinite(ts)) {
        // recency: 1.0 if < 30d, 0.5 if < 180d, 0.2 if < 365d, 0 else.
        const ageDays = (now - ts) / (1000 * 60 * 60 * 24);
        const rec = ageDays < 30 ? 1.0 : ageDays < 180 ? 0.5 : ageDays < 365 ? 0.2 : 0;
        if (rec > recencyMax) recencyMax = rec;
      }
    }
  }
  // Apply the spec formula LITERALLY then clamp. Counts are used as-is
  // (each reputable source contributes 0.30, each positive-sentiment citation
  // 0.05, each contradicting citation -0.10). Final clamp keeps it in [0,1].
  const raw =
    0.30 * hostSet.size +
    0.20 * hasPrimary +
    0.20 * hasGov +
    0.15 * (archiveCount > 0 ? 1 : 0) +
    0.10 * recencyMax +
    0.05 * positiveSent -
    0.10 * contradicting;
  const score = Math.max(0, Math.min(1, raw));
  await env.DB.prepare(`UPDATE facts SET verified_score = ? WHERE id = ?`).bind(score, factId).run();
  return score;
}

export { REPUTABILITY_DEFAULT };
