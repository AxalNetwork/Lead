// Task #5 step 10: compute `to_do_business_with_them`.
//
// Deterministic where possible:
//   - best_time_to_reach    ← scheduleProfiler preference (peak_hour_utc)
//   - preferred_channel     ← communicationProfiler preference
//   - warm_intro_paths      ← rel_edges 2-hop BFS from optional viewer_entity_id
//   - conversation_starters ← top conversation_hooks (recent first)
//   - what_to_offer         ← top appreciation_signals (gift_idea / compliment_topic)
//   - what_to_avoid         ← appreciation_signals labelled "Do not pitch"
//   - gift_ideas            ← appreciation_signals filtered to gift_idea
//   - meeting_prep_notes    ← LLM pass when env.AI present; deterministic
//                              fallback otherwise (concise text built from
//                              the structured signals + cited URLs).
//
// Persisted as a person_dossier_synthesis row.

import type { Env } from "../../types";

export interface ToDoBusinessWithThem {
  conversation_starters: Array<{ text: string; source_url: string; observed_at?: string }>;
  best_time_to_reach: { peak_hour_utc: number | null; rationale: string };
  preferred_channel: { primary: string | null; ranked: string[]; rationale: string };
  warm_intro_paths: Array<{
    via_entity_id: string;
    via_display_name: string | null;
    hops: Array<{ src: string; dst: string; kind: string; strength: number; last_at: string | null }>;
    total_strength: number;
  }>;
  what_to_offer: Array<{ text: string; source_url: string }>;
  what_to_avoid: Array<{ text: string; source_url: string }>;
  gift_ideas: Array<{ text: string; source_url: string }>;
  meeting_prep_notes: { text: string; citations: string[]; generated_by: "llm" | "deterministic" };
}

interface Opts {
  runId: string;
  llmModel?: string;
}

// Public helper: compute viewer-specific warm-intro paths on demand.
// Kept separate from persisted synthesis so the dossier cache stays
// stable per-entity and one caller's viewer cannot pollute another's
// view. Returns at most 10 paths, sorted by combined edge strength.
export async function computeWarmIntroPaths(
  env: Env, entityId: string, viewerEntityId: string,
): Promise<ToDoBusinessWithThem["warm_intro_paths"]> {
  const paths: ToDoBusinessWithThem["warm_intro_paths"] = [];
  const viewerNeighbors = await all<{ dst_entity_id: string; kind: string; strength: number; valid_from: string | null }>(env,
    `SELECT dst_entity_id, kind, strength, valid_from FROM rel_edges WHERE src_entity_id = ? LIMIT 200`,
    viewerEntityId);
  if (!viewerNeighbors.length) return paths;
  const viaIds = viewerNeighbors.map((n) => n.dst_entity_id);
  const placeholders = viaIds.map(() => "?").join(",");
  const targetIn = await all<{ src_entity_id: string; kind: string; strength: number; valid_from: string | null }>(env,
    `SELECT src_entity_id, kind, strength, valid_from FROM rel_edges
        WHERE dst_entity_id = ? AND src_entity_id IN (${placeholders})`,
    entityId, ...viaIds);
  const targetMap = new Map(targetIn.map((t) => [t.src_entity_id, t]));
  for (const vn of viewerNeighbors) {
    const back = targetMap.get(vn.dst_entity_id);
    if (!back) continue;
    const displayRow = await all<{ display_name: string | null }>(env,
      `SELECT display_name FROM u_entities WHERE id = ? LIMIT 1`, vn.dst_entity_id);
    paths.push({
      via_entity_id: vn.dst_entity_id,
      via_display_name: displayRow[0]?.display_name ?? null,
      hops: [
        { src: viewerEntityId, dst: vn.dst_entity_id, kind: vn.kind, strength: vn.strength, last_at: vn.valid_from },
        { src: vn.dst_entity_id, dst: entityId, kind: back.kind, strength: back.strength, last_at: back.valid_from },
      ],
      total_strength: vn.strength * back.strength,
    });
  }
  paths.sort((a, b) => b.total_strength - a.total_strength);
  paths.splice(10);
  return paths;
}

interface Row { [k: string]: unknown }
async function all<T = Row>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try { const r = await env.DB.prepare(sql).bind(...binds).all<T>(); return r.results ?? []; } catch { return []; }
}

export async function synthesize(env: Env, entityId: string, opts: Opts): Promise<{
  synthesisId: string; dossier: ToDoBusinessWithThem;
  conversation_starters_count: number; warm_intro_paths_count: number;
  citations_count: number; llm_model: string | null; llm_neurons: number;
}> {
  // --- conversation_starters: top 10 recent hooks ---
  const hooks = await all<{ hook_text: string; source_url: string; observed_at: string }>(env,
    `SELECT hook_text, source_url, observed_at FROM conversation_hooks
       WHERE entity_id = ? ORDER BY observed_at DESC LIMIT 10`, entityId);
  const conversation_starters = hooks.map((h) => ({
    text: h.hook_text, source_url: h.source_url, observed_at: h.observed_at,
  }));

  // --- best_time_to_reach (from scheduleProfiler preference) ---
  const schedRow = await all<{ value_json: string | null }>(env,
    `SELECT value_json FROM person_preferences WHERE entity_id = ? AND preference_key = 'schedule' LIMIT 1`,
    entityId);
  let peak_hour_utc: number | null = null;
  if (schedRow[0]?.value_json) {
    try {
      const v = JSON.parse(schedRow[0].value_json) as { value?: { peak_hour_utc?: number } };
      if (typeof v?.value?.peak_hour_utc === "number") peak_hour_utc = v.value.peak_hour_utc;
    } catch { /* keep null */ }
  }
  const best_time_to_reach = {
    peak_hour_utc,
    rationale: peak_hour_utc !== null
      ? `Observed posting peak at ${peak_hour_utc}:00 UTC over the last 90 days.`
      : "Insufficient signal to infer a peak hour.",
  };

  // --- preferred_channel (from communicationProfiler preference) ---
  const commRow = await all<{ value_json: string | null }>(env,
    `SELECT value_json FROM person_preferences WHERE entity_id = ? AND preference_key = 'comm_channel' LIMIT 1`,
    entityId);
  let primary: string | null = null; let ranked: string[] = [];
  if (commRow[0]?.value_json) {
    try {
      const v = JSON.parse(commRow[0].value_json) as { value?: { primary?: string; ranked?: string[] } };
      primary = v?.value?.primary ?? null;
      ranked = v?.value?.ranked ?? [];
    } catch { /* keep null */ }
  }
  const preferred_channel = {
    primary, ranked,
    rationale: primary ? `Most-active confirmed channel: ${primary}` : "No active channels confirmed.",
  };

  // --- warm_intro_paths ---
  // Persisted synthesis NEVER stores viewer-specific paths — that would
  // make a global per-entity cache depend on whoever last triggered the
  // run, leaking caller context across readers. Viewer-specific 2-hop
  // BFS is computed at read time by `computeWarmIntroPaths` and merged
  // into the response by routes/profilers.ts /dossier.
  // The persisted fallback surfaces any "Mutual-connection candidate:"
  // appreciation rows already materialized by mutualConnectionProfiler
  // so the entity-level dossier always has SOMETHING here.
  const warm_intro_paths: ToDoBusinessWithThem["warm_intro_paths"] = [];
  const mutuals = await all<{ signal_text: string; source_url: string }>(env,
    `SELECT signal_text, source_url FROM appreciation_signals
       WHERE entity_id = ? AND signal_text LIKE 'Mutual-connection candidate:%'
       ORDER BY confidence DESC LIMIT 10`, entityId);
  for (const m of mutuals) {
    warm_intro_paths.push({
      via_entity_id: "unknown",
      via_display_name: m.signal_text.replace(/^Mutual-connection candidate:\s*/, "").split(" (")[0] || null,
      hops: [],
      total_strength: 0,
    });
  }

  // --- what_to_offer / what_to_avoid / gift_ideas ---
  const appreciation = await all<{ signal_kind: string; signal_text: string; source_url: string }>(env,
    `SELECT signal_kind, signal_text, source_url FROM appreciation_signals
       WHERE entity_id = ? ORDER BY observed_at DESC LIMIT 50`, entityId);
  const what_to_offer = appreciation
    .filter((a) => a.signal_kind === "compliment_topic" || a.signal_kind === "gift_idea" || a.signal_kind === "recognition_received")
    .filter((a) => !a.signal_text.startsWith("Do not pitch:") && !a.signal_text.startsWith("Mutual-connection candidate:"))
    .slice(0, 10)
    .map((a) => ({ text: a.signal_text, source_url: a.source_url }));
  const what_to_avoid = appreciation
    .filter((a) => a.signal_text.startsWith("Do not pitch:"))
    .slice(0, 10)
    .map((a) => ({ text: a.signal_text, source_url: a.source_url }));
  const gift_ideas = appreciation
    .filter((a) => a.signal_kind === "gift_idea")
    .slice(0, 10)
    .map((a) => ({ text: a.signal_text, source_url: a.source_url }));

  // --- meeting_prep_notes ---
  const citations = Array.from(new Set([
    ...conversation_starters.map((c) => c.source_url),
    ...what_to_offer.map((c) => c.source_url),
    ...gift_ideas.map((c) => c.source_url),
  ])).slice(0, 25);
  let prep: ToDoBusinessWithThem["meeting_prep_notes"] = {
    text: buildDeterministicPrep({ conversation_starters, what_to_offer, what_to_avoid, best_time_to_reach, preferred_channel }),
    citations,
    generated_by: "deterministic",
  };
  if (env.AI && conversation_starters.length > 0) {
    try {
      const sys = "You write a 4-sentence meeting-prep note from structured public signals. Cite source URLs inline as [1], [2]. Do NOT invent facts.";
      const lines: string[] = [];
      conversation_starters.slice(0, 5).forEach((h, i) => lines.push(`[${i + 1}] ${h.text} (${h.source_url})`));
      what_to_offer.slice(0, 3).forEach((o, i) => lines.push(`[${conversation_starters.length + i + 1}] OFFER: ${o.text} (${o.source_url})`));
      const prompt = `Person dossier signals:\n${lines.join("\n")}\n\nWrite the prep note now.`;
      const ai = env.AI as unknown as { run: (model: string, input: { messages: { role: string; content: string }[] }) => Promise<{ response?: string }> };
      const model = opts.llmModel ?? "@cf/meta/llama-3.1-8b-instruct";
      const resp = await ai.run(model, { messages: [{ role: "system", content: sys }, { role: "user", content: prompt }] });
      if (resp?.response) {
        prep = { text: String(resp.response).slice(0, 1200), citations, generated_by: "llm" };
      }
    } catch { /* fall back to deterministic */ }
  }

  const dossier: ToDoBusinessWithThem = {
    conversation_starters,
    best_time_to_reach,
    preferred_channel,
    warm_intro_paths,
    what_to_offer,
    what_to_avoid,
    gift_ideas,
    meeting_prep_notes: prep,
  };

  const synthesisId = crypto.randomUUID();
  const computedAt = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO person_dossier_synthesis
       (id, entity_id, run_id, computed_at, to_do_business_with_them_json,
        conversation_starters_count, warm_intro_paths_count, citations_count,
        llm_model, llm_neurons, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    synthesisId, entityId, opts.runId, computedAt,
    JSON.stringify(dossier),
    conversation_starters.length, warm_intro_paths.length, citations.length,
    prep.generated_by === "llm" ? (opts.llmModel ?? "@cf/meta/llama-3.1-8b-instruct") : null,
    0, null,
  ).run();

  return {
    synthesisId, dossier,
    conversation_starters_count: conversation_starters.length,
    warm_intro_paths_count: warm_intro_paths.length,
    citations_count: citations.length,
    llm_model: prep.generated_by === "llm" ? (opts.llmModel ?? "@cf/meta/llama-3.1-8b-instruct") : null,
    llm_neurons: 0,
  };
}

function buildDeterministicPrep(args: {
  conversation_starters: Array<{ text: string; source_url: string }>;
  what_to_offer: Array<{ text: string }>;
  what_to_avoid: Array<{ text: string }>;
  best_time_to_reach: { peak_hour_utc: number | null };
  preferred_channel: { primary: string | null };
}): string {
  const parts: string[] = [];
  if (args.conversation_starters[0]) {
    parts.push(`Open with: "${args.conversation_starters[0].text}".`);
  }
  if (args.preferred_channel.primary) {
    parts.push(`Reach out via ${args.preferred_channel.primary}.`);
  }
  if (args.best_time_to_reach.peak_hour_utc !== null) {
    parts.push(`Aim for around ${args.best_time_to_reach.peak_hour_utc}:00 UTC.`);
  }
  if (args.what_to_offer[0]) {
    parts.push(`Lead with value: ${args.what_to_offer[0].text}.`);
  }
  if (args.what_to_avoid[0]) {
    parts.push(`Avoid: ${args.what_to_avoid[0].text}.`);
  }
  return parts.join(" ") || "Insufficient structured signal for a tailored prep note.";
}
