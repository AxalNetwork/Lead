// Task #3: Profile-type classifier.
//
// Pipeline (idempotent, retry-safe):
//   1. Gather evidence — news mentions (top by reputability), wikipedia/wikidata
//      facts, channels, donations + appointments rows, rel_edges counts.
//   2. Call Workers AI three times:
//        a) types — { politician: 0.7, founder: 0.2, … }
//        b) ideology — five axes -1..+1 (NULL when no evidence) + confidence
//        c) interests/hobbies/causes — array of { label, weight, source }
//      Each call is cached by sha256(model + prompt + evidence_hash).
//   3. Compute derived influence axes (see influence.ts).
//   4. Compute is_pep / is_government_official / is_lobbyist booleans.
//   5. Generate AI summary (see summary.ts) keyed by evidence hash.
//   6. Persist via repo.ts (operator overrides preserved).
//   7. Append entity_history row + insert evidence quotes.

import type { Env } from "../types";
import { upsertProfileAxes, insertEvidence, getProfileAxes } from "./repo";
import { computeInfluence } from "./influence";
import { generateProfileSummary } from "./summary";
import { aiCacheGet, aiCachePut, sha256Hex } from "../ai/cache";
import { assertBudget } from "../ai/budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";

export const CLASSIFIER_VERSION = "v1.0-llama3.1-8b";

const TYPE_VOCAB = [
  "politician", "founder", "investor", "executive", "academic", "journalist",
  "activist", "celebrity", "lawyer", "lobbyist", "government_official",
  "philanthropist", "board_director", "operator", "influencer", "other",
] as const;

const AI_TIMEOUT_MS = 30_000;

async function runAiWithTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race<T>([
      p,
      new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(`ai_timeout:${label}:${ms}ms`)), ms); }),
    ]);
  } finally { if (timer) clearTimeout(timer); }
}

export interface EvidenceItem {
  source_kind: "news" | "wikidata" | "wikipedia" | "fec" | "propublica" | "manual" | "fact" | "other";
  source_url?: string | null;
  news_item_id?: string | null;
  observed_at?: string | null;
  text: string;            // sentence/quote
}

export interface ClassifyResult {
  entity_id: string;
  evidence_count: number;
  primary_type: string | null;
  ideology_conf: number | null;
  is_pep: boolean;
  summary_present: boolean;
  cached: boolean;
}

export async function classifyEntity(env: Env, entityId: string, opts?: { force?: boolean }): Promise<ClassifyResult> {
  const ent = await env.DB.prepare(`SELECT id, kind, display_name FROM u_entities WHERE id = ?`).bind(entityId).first<{ id: string; kind: string; display_name: string | null }>();
  if (!ent) throw new Error(`entity_not_found:${entityId}`);

  // 1. Evidence corpus
  const evidence = await gatherEvidence(env, entityId);
  const evidenceText = evidence.map((e) => e.text).join("\n").slice(0, 12_000);
  const evidenceHash = await sha256Hex(`${CLASSIFIER_VERSION}:${entityId}:${evidenceText}`);

  // Short-circuit when we already classified this exact evidence corpus
  // unless caller requested a force-refresh.
  if (!opts?.force) {
    const cur = await getProfileAxes(env, entityId);
    if (cur && cur.summary_evidence_hash === evidenceHash && cur.classified_at) {
      return {
        entity_id: entityId,
        evidence_count: cur.evidence_count,
        primary_type: cur.primary_type,
        ideology_conf: cur.ideology_conf,
        is_pep: !!cur.is_pep,
        summary_present: !!cur.summary_text,
        cached: true,
      };
    }
  }

  const subject = ent.display_name ?? entityId;

  // 2. AI calls — 3 of them, each cached by hash.
  const types = await aiClassifyTypes(env, subject, evidenceText, evidenceHash);
  const ideology = ideologyAxesEnabled(env) ? await aiClassifyIdeology(env, subject, evidenceText, evidenceHash) : EMPTY_IDEOLOGY;
  const interests = await aiClassifyInterests(env, subject, evidenceText, evidenceHash);

  // 3. Derived influence
  const influence = await computeInfluence(env, entityId);

  // 4. Booleans from rows
  const isPep = await isPoliticallyExposed(env, entityId);
  const isGovt = await hasCurrentGovernmentAppt(env, entityId);
  const isLobby = (types.weights["lobbyist"] ?? 0) > 0.3;

  // Primary type pick
  let primaryType: string | null = null;
  let primaryConf = 0;
  for (const [k, v] of Object.entries(types.weights)) {
    if (v > primaryConf) { primaryType = k; primaryConf = v; }
  }

  // 5. AI summary (cached by evidenceHash)
  const summary = await generateProfileSummary(env, {
    entityId, subject, evidenceHash, evidenceText,
    primaryType, ideologyConf: ideology.confidence, isPep, isGovt,
  });

  // 6. Persist + record evidence
  await upsertProfileAxes(env, entityId, {
    type_weights: types.weights,
    primary_type: primaryType,
    primary_type_conf: primaryConf,
    left_right: ideology.left_right,
    lib_auth: ideology.lib_auth,
    prog_cons: ideology.prog_cons,
    glob_nat: ideology.glob_nat,
    sec_rel: ideology.sec_rel,
    ideology_conf: ideology.confidence,
    network_centrality: influence.network_centrality,
    media_influence: influence.media_influence,
    capital_influence: influence.capital_influence,
    political_influence: influence.political_influence,
    interests: interests.interests,
    hobbies: interests.hobbies,
    causes: interests.causes,
    summary_text: summary,
    summary_evidence_hash: evidenceHash,
    is_pep: isPep ? 1 : 0,
    is_government_official: isGovt ? 1 : 0,
    is_lobbyist: isLobby ? 1 : 0,
    evidence_count: evidence.length,
    classifier_version: CLASSIFIER_VERSION,
    classified_at: new Date().toISOString(),
    refreshed_at: new Date().toISOString(),
  });

  // Evidence rows backing each top type + ideology evidence quotes the
  // model returned (truncated). We do NOT re-cite every news mention —
  // citations.ts already does that. We just pin the top-N supporting
  // quotes for the classification axes themselves.
  const evidenceRows = (types.evidence_quotes ?? []).slice(0, 8).map((q) => ({
    entity_id: entityId,
    axis: `type:${q.label}`,
    score: q.score ?? null,
    quote: q.quote,
    source_kind: "news",
    news_item_id: q.news_item_id ?? null,
  }));
  const ideologyEvidence = (ideology.evidence_quotes ?? []).slice(0, 5).map((q) => ({
    entity_id: entityId,
    axis: `ideology:${q.axis}`,
    score: q.score ?? null,
    quote: q.quote,
    source_kind: "news",
  }));
  await insertEvidence(env, [...evidenceRows, ...ideologyEvidence]);

  // 7. entity_history audit row
  try {
    await env.DB.prepare(
      `INSERT INTO entity_history (id, entity_id, action, source, changed_at, new_value)
       VALUES (?, ?, 'classify', 'system', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      entityId,
      new Date().toISOString(),
      JSON.stringify({ primary_type: primaryType, ideology_conf: ideology.confidence, is_pep: isPep, version: CLASSIFIER_VERSION }),
    ).run();
  } catch (e) {
    console.warn("classify entity_history insert failed", (e as Error).message);
  }

  return {
    entity_id: entityId,
    evidence_count: evidence.length,
    primary_type: primaryType,
    ideology_conf: ideology.confidence,
    is_pep: isPep,
    summary_present: !!summary,
    cached: false,
  };
}

// ---------------- evidence gathering ----------------

async function gatherEvidence(env: Env, entityId: string): Promise<EvidenceItem[]> {
  const out: EvidenceItem[] = [];

  // (a) Top news mentions by reputability
  const newsRows = await env.DB.prepare(
    `SELECT ni.id, ni.url, ni.title, ni.summary, ni.published_at,
            nem.context_quote, ni.source_reputability
       FROM news_entity_mentions nem
       JOIN news_items ni ON ni.id = nem.news_item_id
      WHERE nem.entity_id = ?
      ORDER BY ni.source_reputability DESC, ni.published_at DESC
      LIMIT 30`,
  ).bind(entityId).all<{ id: string; url: string; title: string | null; summary: string | null; published_at: string | null; context_quote: string | null; source_reputability: number }>();
  for (const n of newsRows.results ?? []) {
    const text = (n.context_quote ?? n.summary ?? n.title ?? "").slice(0, 600);
    if (text) out.push({ source_kind: "news", source_url: n.url, news_item_id: n.id, observed_at: n.published_at, text });
  }

  // (b) Existing facts (e.g. employer/title/role from prior pipelines)
  const factRows = await env.DB.prepare(
    `SELECT predicate, value_text, value_number, source FROM facts WHERE entity_id = ? LIMIT 50`,
  ).bind(entityId).all<{ predicate: string; value_text: string | null; value_number: number | null; source: string | null }>();
  for (const f of factRows.results ?? []) {
    const v = f.value_text ?? (f.value_number != null ? String(f.value_number) : "");
    if (v) out.push({ source_kind: "fact", text: `${f.predicate}: ${v}` });
  }

  // (c) Government appointments — push as evidence even though they
  // get used directly for the is_pep flag. The LLM uses them for types.
  const apptRows = await env.DB.prepare(
    `SELECT title, body, jurisdiction, party, start_date, end_date FROM government_appointments WHERE entity_id = ? LIMIT 20`,
  ).bind(entityId).all<{ title: string; body: string | null; jurisdiction: string | null; party: string | null; start_date: string | null; end_date: string | null }>();
  for (const a of apptRows.results ?? []) {
    out.push({
      source_kind: "wikidata",
      text: `Appointed ${a.title}${a.body ? " of " + a.body : ""}${a.jurisdiction ? " (" + a.jurisdiction + ")" : ""}${a.party ? ", " + a.party : ""}${a.start_date ? ", from " + a.start_date : ""}${a.end_date ? " to " + a.end_date : ""}.`,
    });
  }

  // (d) Donations — capped at 25 most recent
  const donRows = await env.DB.prepare(
    `SELECT recipient_name, recipient_party, amount_usd, cycle, occurred_at FROM political_donations WHERE entity_id = ? ORDER BY occurred_at DESC LIMIT 25`,
  ).bind(entityId).all<{ recipient_name: string; recipient_party: string | null; amount_usd: number | null; cycle: number | null; occurred_at: string | null }>();
  for (const d of donRows.results ?? []) {
    out.push({
      source_kind: "fec",
      text: `Donated $${d.amount_usd ?? "?"} to ${d.recipient_name}${d.recipient_party ? " (" + d.recipient_party + ")" : ""}${d.cycle ? ", " + d.cycle : ""}.`,
      observed_at: d.occurred_at,
    });
  }

  return out;
}

// ---------------- AI classification calls ----------------

interface TypesResult {
  weights: Record<string, number>;
  evidence_quotes: Array<{ label: string; score?: number; quote: string; news_item_id?: string }>;
}
const EMPTY_TYPES: TypesResult = { weights: {}, evidence_quotes: [] };

async function aiClassifyTypes(env: Env, subject: string, evidence: string, evidenceHash: string): Promise<TypesResult> {
  if (!env.AI || !evidence.trim()) return EMPTY_TYPES;
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const cacheKey = await sha256Hex(`${model}:types:${evidenceHash}`);
  const cached = await aiCacheGet<TypesResult>(env, cacheKey);
  if (cached) { trackAi(env, { purpose: "classify_types", model, cacheHit: true }); return cached; }
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return EMPTY_TYPES;
  if (!(await limitAi(env))) return EMPTY_TYPES;

  const sys = `You classify a public person across these profile types: ${TYPE_VOCAB.join(", ")}.
Return ONLY strict JSON: {"weights": {"<type>": 0..1, ...}, "evidence_quotes": [{"label":"<type>","quote":"<short verbatim quote from evidence>"}]}.
- Weights sum to ~1.0. Omit any type with weight < 0.05.
- Each evidence_quote must be a verbatim sentence from the evidence; max 240 chars; max 5 quotes total.
- If the person clearly serves in elected office or has been appointed to a government body, include "politician" and/or "government_official".`;

  try {
    const t0 = Date.now();
    const res = (await runAiWithTimeout(env.AI.run(model, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `SUBJECT: ${subject}\n\nEVIDENCE:\n${evidence}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
      temperature: 0.1,
    }), AI_TIMEOUT_MS, "classify_types")) as { response?: string } | string;
    trackAi(env, { purpose: "classify_types", model, ms: Date.now() - t0 });
    const out = parseTypesResponse(res);
    await aiCachePut(env, cacheKey, out);
    return out;
  } catch (e) {
    console.warn("aiClassifyTypes failed", (e as Error).message);
    return EMPTY_TYPES;
  }
}

function parseTypesResponse(res: { response?: string } | string): TypesResult {
  const raw = typeof res === "string" ? res : (res?.response ?? "");
  if (!raw) return EMPTY_TYPES;
  try {
    const j = JSON.parse(raw) as { weights?: Record<string, unknown>; evidence_quotes?: unknown };
    const weights: Record<string, number> = {};
    if (j.weights && typeof j.weights === "object") {
      for (const [k, v] of Object.entries(j.weights)) {
        if (!(TYPE_VOCAB as readonly string[]).includes(k)) continue;
        const n = Number(v);
        if (Number.isFinite(n) && n > 0) weights[k] = Math.min(1, Math.max(0, n));
      }
    }
    // Normalize so they sum to ≤1.
    const sum = Object.values(weights).reduce((a, b) => a + b, 0);
    if (sum > 1.0001) for (const k of Object.keys(weights)) weights[k] = weights[k] / sum;
    const quotes = Array.isArray(j.evidence_quotes) ? (j.evidence_quotes as Array<{ label?: string; quote?: string; score?: number; news_item_id?: string }>)
      .filter((q) => q && typeof q.label === "string" && typeof q.quote === "string")
      .slice(0, 5)
      .map((q) => ({ label: q.label as string, quote: (q.quote as string).slice(0, 240), score: typeof q.score === "number" ? q.score : undefined, news_item_id: q.news_item_id }))
      : [];
    return { weights, evidence_quotes: quotes };
  } catch { return EMPTY_TYPES; }
}

interface IdeologyResult {
  left_right: number | null;
  lib_auth: number | null;
  prog_cons: number | null;
  glob_nat: number | null;
  sec_rel: number | null;
  confidence: number | null;
  evidence_quotes: Array<{ axis: string; score?: number; quote: string }>;
}
const EMPTY_IDEOLOGY: IdeologyResult = {
  left_right: null, lib_auth: null, prog_cons: null, glob_nat: null, sec_rel: null,
  confidence: null, evidence_quotes: [],
};

function ideologyAxesEnabled(env: Env): boolean {
  // Operator escape hatch: setting CLASSIFIER_IDEOLOGY=off disables the
  // ideology axes entirely (defaults stay NULL). Useful for jurisdictions
  // where political profiling carries higher compliance risk.
  return (env.CLASSIFIER_IDEOLOGY ?? "on").toLowerCase() !== "off";
}

async function aiClassifyIdeology(env: Env, subject: string, evidence: string, evidenceHash: string): Promise<IdeologyResult> {
  if (!env.AI || !evidence.trim()) return EMPTY_IDEOLOGY;
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const cacheKey = await sha256Hex(`${model}:ideology:${evidenceHash}`);
  const cached = await aiCacheGet<IdeologyResult>(env, cacheKey);
  if (cached) { trackAi(env, { purpose: "classify_ideology", model, cacheHit: true }); return cached; }
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return EMPTY_IDEOLOGY;
  if (!(await limitAi(env))) return EMPTY_IDEOLOGY;

  const sys = `You estimate a public person's political ideology across five axes from PUBLIC EVIDENCE ONLY.
Axes:
  left_right:  -1 (far left)         .. +1 (far right)
  lib_auth:    -1 (libertarian)      .. +1 (authoritarian)
  prog_cons:   -1 (progressive)      .. +1 (conservative)
  glob_nat:    -1 (globalist)        .. +1 (nationalist)
  sec_rel:     -1 (secular)          .. +1 (religious)
Return ONLY strict JSON: {"left_right": <number|null>, "lib_auth": <…>, "prog_cons": <…>, "glob_nat": <…>, "sec_rel": <…>, "confidence": 0..1, "evidence_quotes":[{"axis":"left_right","score":-0.6,"quote":"<verbatim sentence>"}]}.
Rules:
- If the evidence does NOT support a position on an axis, set that axis to null. NEVER default to 0.
- "confidence" is overall — set 0 when all axes are null.
- Max 5 evidence_quotes. Each quote ≤240 chars, verbatim from the evidence.`;

  try {
    const t0 = Date.now();
    const res = (await runAiWithTimeout(env.AI.run(model, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `SUBJECT: ${subject}\n\nEVIDENCE:\n${evidence}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 600,
      temperature: 0.1,
    }), AI_TIMEOUT_MS, "classify_ideology")) as { response?: string } | string;
    trackAi(env, { purpose: "classify_ideology", model, ms: Date.now() - t0 });
    const out = parseIdeologyResponse(res);
    await aiCachePut(env, cacheKey, out);
    return out;
  } catch (e) {
    console.warn("aiClassifyIdeology failed", (e as Error).message);
    return EMPTY_IDEOLOGY;
  }
}

function parseIdeologyResponse(res: { response?: string } | string): IdeologyResult {
  const raw = typeof res === "string" ? res : (res?.response ?? "");
  if (!raw) return EMPTY_IDEOLOGY;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const clamp = (k: string): number | null => {
      const v = j[k];
      if (v === null || v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      return Math.min(1, Math.max(-1, n));
    };
    const conf = Number(j.confidence);
    const quotes = Array.isArray(j.evidence_quotes)
      ? (j.evidence_quotes as Array<{ axis?: string; score?: number; quote?: string }>)
          .filter((q) => q && typeof q.axis === "string" && typeof q.quote === "string")
          .slice(0, 5)
          .map((q) => ({ axis: q.axis as string, score: typeof q.score === "number" ? q.score : undefined, quote: (q.quote as string).slice(0, 240) }))
      : [];
    return {
      left_right: clamp("left_right"),
      lib_auth: clamp("lib_auth"),
      prog_cons: clamp("prog_cons"),
      glob_nat: clamp("glob_nat"),
      sec_rel: clamp("sec_rel"),
      confidence: Number.isFinite(conf) ? Math.min(1, Math.max(0, conf)) : null,
      evidence_quotes: quotes,
    };
  } catch { return EMPTY_IDEOLOGY; }
}

interface InterestsResult {
  interests: Array<{ label: string; weight: number; source?: string }>;
  hobbies: Array<{ label: string; weight: number; source?: string }>;
  causes: Array<{ label: string; weight: number; source?: string }>;
}
const EMPTY_INTERESTS: InterestsResult = { interests: [], hobbies: [], causes: [] };

async function aiClassifyInterests(env: Env, subject: string, evidence: string, evidenceHash: string): Promise<InterestsResult> {
  if (!env.AI || !evidence.trim()) return EMPTY_INTERESTS;
  const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
  const cacheKey = await sha256Hex(`${model}:interests:${evidenceHash}`);
  const cached = await aiCacheGet<InterestsResult>(env, cacheKey);
  if (cached) { trackAi(env, { purpose: "classify_interests", model, cacheHit: true }); return cached; }
  const ok = await assertBudget(env, "ai");
  if (!ok.ok) return EMPTY_INTERESTS;
  if (!(await limitAi(env))) return EMPTY_INTERESTS;

  const sys = `Extract the subject's interests / hobbies / causes from PUBLIC evidence.
Return ONLY strict JSON: {"interests":[{"label":"<short noun phrase>","weight":0..1}], "hobbies":[…], "causes":[…]}.
- interests = policy areas, professional topics (e.g. "climate policy", "fintech").
- hobbies   = non-political pastimes (e.g. "marathon running", "chess").
- causes    = charitable or activist causes (e.g. "Type-1 diabetes research").
- Max 10 entries per array. Use lowercase labels. Skip vague terms.
- Only include what the evidence actually supports.`;

  try {
    const t0 = Date.now();
    const res = (await runAiWithTimeout(env.AI.run(model, {
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `SUBJECT: ${subject}\n\nEVIDENCE:\n${evidence}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 500,
      temperature: 0.2,
    }), AI_TIMEOUT_MS, "classify_interests")) as { response?: string } | string;
    trackAi(env, { purpose: "classify_interests", model, ms: Date.now() - t0 });
    const out = parseInterestsResponse(res);
    await aiCachePut(env, cacheKey, out);
    return out;
  } catch (e) {
    console.warn("aiClassifyInterests failed", (e as Error).message);
    return EMPTY_INTERESTS;
  }
}

function parseInterestsResponse(res: { response?: string } | string): InterestsResult {
  const raw = typeof res === "string" ? res : (res?.response ?? "");
  if (!raw) return EMPTY_INTERESTS;
  try {
    const j = JSON.parse(raw) as Record<string, unknown>;
    const pick = (k: string) => {
      const v = j[k];
      if (!Array.isArray(v)) return [];
      return (v as Array<{ label?: unknown; weight?: unknown; source?: unknown }>)
        .filter((x) => x && typeof x.label === "string")
        .slice(0, 10)
        .map((x) => ({
          label: String(x.label).toLowerCase().slice(0, 80),
          weight: Number.isFinite(Number(x.weight)) ? Math.min(1, Math.max(0, Number(x.weight))) : 0.5,
          source: typeof x.source === "string" ? (x.source as string).slice(0, 40) : undefined,
        }));
    };
    return { interests: pick("interests"), hobbies: pick("hobbies"), causes: pick("causes") };
  } catch { return EMPTY_INTERESTS; }
}

// ---------------- boolean flags ----------------

async function isPoliticallyExposed(env: Env, entityId: string): Promise<boolean> {
  // PEP if: current government appointment OR any donation ≥ $10k in
  // the last 4 cycles OR has a "politician" / "government_official"
  // fact_tag from a prior import.
  const a = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM government_appointments WHERE entity_id = ? AND (is_current = 1 OR end_date IS NULL)`,
  ).bind(entityId).first<{ n: number }>();
  if ((a?.n ?? 0) > 0) return true;

  const d = await env.DB.prepare(
    `SELECT COALESCE(SUM(amount_usd), 0) AS s FROM political_donations
       WHERE entity_id = ? AND COALESCE(cycle, 0) >= ?`,
  ).bind(entityId, new Date().getFullYear() - 8).first<{ s: number }>();
  if ((d?.s ?? 0) >= 10_000) return true;

  return false;
}

async function hasCurrentGovernmentAppt(env: Env, entityId: string): Promise<boolean> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM government_appointments WHERE entity_id = ? AND (is_current = 1 OR end_date IS NULL)`,
  ).bind(entityId).first<{ n: number }>();
  return (r?.n ?? 0) > 0;
}

// ---------------- batch entrypoint ----------------

export async function classifyBatch(env: Env, opts?: { limit?: number; staleDays?: number }): Promise<{ scanned: number; classified: number; errors: number }> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 500);
  const staleDays = opts?.staleDays ?? 7;
  const rows = await env.DB.prepare(
    `SELECT u.id FROM u_entities u
       LEFT JOIN entity_profile_axes a ON a.entity_id = u.id
      WHERE u.status = 'active' AND u.display_name IS NOT NULL
        AND (a.refreshed_at IS NULL OR datetime(a.refreshed_at) < datetime('now', ?))
      ORDER BY u.quality_score DESC, u.updated_at DESC
      LIMIT ?`,
  ).bind(`-${staleDays} days`, limit).all<{ id: string }>();

  let classified = 0, errors = 0;
  for (const r of rows.results ?? []) {
    try { await classifyEntity(env, r.id); classified++; }
    catch (e) { errors++; console.warn("classifyBatch fail", r.id, (e as Error).message); }
  }
  return { scanned: rows.results?.length ?? 0, classified, errors };
}
