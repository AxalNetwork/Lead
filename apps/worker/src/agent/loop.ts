// Task #3: agent loop.
//
// Drives an interleaved tool-call ↔ model-response cycle. The model is
// asked to emit, on each turn, EITHER:
//   { "tool_call": { "name": "<tool>", "arguments": {...} } }
// or
//   { "final": { "answer_markdown": "..." } }
//
// Strict JSON schema keeps the Workers AI model on rails. Hard caps:
//   - 8 tool calls per question
//   - 30s wall-clock budget (deadline-based; respected at every loop tick)
//
// Plan-first pass: cheap model (`AI_EXTRACT_MODEL`, llama-3.1-8b-instruct-fast)
// runs the first turn so the agent can plan its tool strategy cheaply.
// Subsequent reasoning turns use the larger model
// (`@cf/meta/llama-3.3-70b-instruct-fp8-fast`). Final synthesis turn
// also uses the larger model.
//
// Citation contract: every factual sentence must carry at least one
// [E:id]/[F:id]/[N:id]/[T:id]/[R:id]/[M:id]/[W:idx] marker that resolves
// in the CitationRegistry. We re-prompt up to 2 times if final-answer
// sentences are missing citations; after 2 failures, offending sentences
// get an inline "uncited claim" pill instead of being dropped.
//
// Fallback: if `AGENT_FALLBACK_KEY` is set and Workers AI fails / returns
// malformed JSON, the loop transparently retries the same turn against
// the configured fallback provider (OpenAI / Anthropic). Absent ⇒
// Workers-AI-only — never asks the user for a key.

import type { Env } from "../types";
import { CitationRegistry, type CitationPayload } from "./registry";
import { TOOLS, getTool, toolManifest, validateToolArgs } from "./tools";
import { cacheKey, cacheGet, cachePut } from "./cache";
import { estimateTokens } from "./budget";

const PRIMARY_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const PLAN_MODEL    = "@cf/meta/llama-3.1-8b-instruct-fast";

export const MAX_TOOL_CALLS = 8;
export const WALL_CLOCK_MS  = 30_000;
const MAX_CITATION_RETRIES   = 2;

export type LoopEvent =
  | { type: "tool_call"; name: string; arguments: Record<string, unknown>; cached?: boolean }
  | { type: "tool_result"; name: string; row_count: number; note?: string; took_ms: number }
  | { type: "citation_registered"; marker: string; payload: CitationPayload }
  | { type: "assistant_token"; text: string }
  | { type: "final"; answer_markdown: string; citations: Array<{ marker: string; payload: CitationPayload }>; uncited_sentences: number; tokens_in: number; tokens_out: number }
  | { type: "error"; message: string }
  | { type: "partial"; answer_markdown: string; reason: "tool_cap" | "deadline" }
  | { type: "follow_ups"; questions: string[] };

export interface LoopOptions {
  emit: (ev: LoopEvent) => Promise<void> | void;
  isCancelled?: () => Promise<boolean> | boolean;
  deadlineMs?: number;
  // When true, the loop calls webSearch automatically once at the end if
  // earlier DB tools all returned zero rows. Disabled for refresh runs.
  autoWebFallback?: boolean;
}

interface ChatMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  // For tool turns we keep the tool name in `content` JSON envelope, no
  // separate field is needed (Workers AI tool calling is via JSON schema
  // not OpenAI-style function calls).
}

const PROTOCOL = `You are AI Data Signal's research agent. You answer questions by calling typed server-side TOOLS over a private lead-intelligence database. You MUST follow this protocol.

PROTOCOL — every response is strict JSON, one of two shapes:
  {"tool_call": {"name": "<toolName>", "arguments": { ... }}}
  {"final":     {"answer_markdown": "<markdown with citation pills>"}}

CITATION RULES — every factual sentence in your final answer must carry at least one citation pill. Pills are bracket markers like [E:abc-123] (entity), [F:fact-id] (fact row), [N:news-id] (news article), [T:transcript-id] (transcript), [R:rel-id] (relationship), [M:media-id] (media), [W:0] (web hit). Only cite IDs the TOOLS actually returned. NEVER invent IDs. If a tool returns zero rows, say so plainly.

PLANNING — call cheap tools first (searchEntities, searchNews, aggregate) before expensive ones (runDDScan, getPath). Hard cap: 8 tool calls. Hard wall-clock: 30 seconds.

HONESTY — if the database has no answer, say so explicitly. Optionally call webSearch as a last resort; web hits are clearly marked [W:idx]. Never fabricate facts.`;

function makeToolDigest(): string {
  return toolManifest()
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");
}

interface ModelResponse {
  ok: boolean;
  raw: string;
  parsed?: { tool_call?: { name?: string; arguments?: Record<string, unknown> }; final?: { answer_markdown?: string } };
  error?: string;
}

async function runModel(env: Env, model: string, messages: ChatMsg[]): Promise<ModelResponse> {
  if (!env.AI) return { ok: false, raw: "", error: "no_ai_binding" };
  try {
    const res = (await env.AI.run(model, {
      messages,
      response_format: { type: "json_object" },
      max_tokens: 1500,
    } as Record<string, unknown>)) as { response?: string };
    const raw = typeof res?.response === "string" ? res.response : JSON.stringify(res ?? {});
    try {
      const parsed = JSON.parse(raw);
      return { ok: true, raw, parsed };
    } catch {
      // Try to extract the first {...} block.
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) {
        try { return { ok: true, raw, parsed: JSON.parse(m[0]) }; } catch { /* fall through */ }
      }
      return { ok: false, raw, error: "malformed_json" };
    }
  } catch (e) {
    return { ok: false, raw: "", error: (e as Error).message };
  }
}

async function runFallback(env: Env, messages: ChatMsg[]): Promise<ModelResponse> {
  if (!env.AGENT_FALLBACK_KEY) return { ok: false, raw: "", error: "no_fallback_key" };
  const provider = (env.AGENT_FALLBACK_PROVIDER ?? "openai").toLowerCase();
  try {
    if (provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": env.AGENT_FALLBACK_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "claude-3-5-sonnet-latest",
          max_tokens: 1500,
          system: messages.find((m) => m.role === "system")?.content ?? "",
          messages: messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: m.content })),
        }),
      });
      const j = (await res.json()) as { content?: Array<{ text?: string }> };
      const raw = j.content?.[0]?.text ?? "";
      try { return { ok: true, raw, parsed: JSON.parse(raw) }; }
      catch { return { ok: false, raw, error: "malformed_json" }; }
    }
    // openai (default)
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.AGENT_FALLBACK_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages,
        response_format: { type: "json_object" },
        temperature: 0.2,
        max_tokens: 1500,
      }),
    });
    const j = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = j.choices?.[0]?.message?.content ?? "";
    try { return { ok: true, raw, parsed: JSON.parse(raw) }; }
    catch { return { ok: false, raw, error: "malformed_json" }; }
  } catch (e) {
    return { ok: false, raw: "", error: (e as Error).message };
  }
}

async function callModel(env: Env, model: string, messages: ChatMsg[]): Promise<ModelResponse> {
  const a = await runModel(env, model, messages);
  if (a.ok) return a;
  if (env.AGENT_FALLBACK_KEY) {
    const b = await runFallback(env, messages);
    if (b.ok) return b;
  }
  return a;
}

// Split a markdown answer into sentence-ish chunks. Used by the citation
// post-processor to identify sentences missing any [K:id] marker.
function sentenceSplit(md: string): string[] {
  // Strip code blocks/markdown headers so we only check prose.
  const body = md.replace(/```[\s\S]*?```/g, " ");
  return body.split(/(?<=[.!?])\s+(?=[A-Z[])/g).map((s) => s.trim()).filter(Boolean);
}

function isFactual(sentence: string): boolean {
  // Skip meta/instructional sentences, headings, list-bullet leaders, and
  // disclaimers that don't assert a fact.
  const s = sentence.replace(/^[#>*\-\d.\s]+/, "").trim();
  if (!s) return false;
  if (s.length < 12) return false;
  if (/^(here are|here is|the following|i (don't|do not|couldn't|could not|need|needed)|note:|disclaimer)/i.test(s)) return false;
  return true;
}

function citationCount(sentence: string): number {
  return (sentence.match(/\[[EFNTRMW]:[^\]]+\]/g) ?? []).length;
}

function flagUncited(md: string, registry: CitationRegistry): { annotated: string; uncited: number } {
  const sentences = sentenceSplit(md);
  let uncited = 0;
  const annotated = sentences.map((s) => {
    if (!isFactual(s)) return s;
    const markers = CitationRegistry.extractMarkers(s).filter((m) => registry.has(m));
    if (markers.length === 0 && citationCount(s) === 0) {
      uncited++;
      return `${s} *(uncited claim — verify manually)*`;
    }
    return s;
  });
  return { annotated: annotated.join(" "), uncited };
}

export async function runAgentLoop(env: Env, question: string, opts: LoopOptions): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + (opts.deadlineMs ?? WALL_CLOCK_MS);
  const reg = new CitationRegistry();
  let toolCallsUsed = 0;
  let tokensIn = 0, tokensOut = 0;
  const allRowCounts: number[] = [];

  const deadlineHit = () => Date.now() >= deadline;
  const cancelled = async () => (opts.isCancelled ? !!(await opts.isCancelled()) : false);

  const messages: ChatMsg[] = [
    { role: "system", content: `${PROTOCOL}\n\nAVAILABLE TOOLS:\n${makeToolDigest()}` },
    { role: "user", content: question },
  ];
  tokensIn += estimateTokens(messages.map((m) => m.content).join("\n"));

  // When true, the loop forces the model to synthesize a final answer
  // (no more tool_call branches accepted) on the next turn. We flip this
  // once the 8-tool cap is reached so the agent still gets one synthesis
  // pass over the evidence it has gathered.
  let synthesisOnly = false;

  while (true) {
    // Mandated short-circuit on hard caps. Both the 30s wall-clock and the
    // 8-tool ceiling MUST emit a `partial` event prefixed with the exact
    // string "I needed more time — these are the partial results." so the
    // dashboard can render the partial banner uniformly. We still do ONE
    // best-effort synthesis turn on tool-cap so the partial body carries
    // a cited summary of the evidence already gathered, but the event
    // type and prefix stay the same as the deadline branch.
    if (deadlineHit() || await cancelled()) {
      const body = synthesizePartial(allRowCounts, reg);
      const { annotated } = flagUncited(body, reg);
      await opts.emit({ type: "partial", answer_markdown: `I needed more time — these are the partial results.\n\n${annotated}`, reason: "deadline" });
      return;
    }
    if (toolCallsUsed >= MAX_TOOL_CALLS && !synthesisOnly) {
      // Push a synthesis instruction and take ONE more model turn (still
      // counted as a synthesis pass, no tool_call allowed) to produce a
      // body for the partial response. If the model misbehaves or errors,
      // we fall back to synthesizePartial below.
      synthesisOnly = true;
      messages.push({
        role: "system",
        content: "TOOL CAP REACHED (8/8). Tool calls are closed. Reply with {\"final\":{\"answer_markdown\":...}} only — a fully-cited synthesis of the tool results already returned.",
      });
    }

    const isPlan = toolCallsUsed === 0 && !synthesisOnly;
    const model = isPlan ? PLAN_MODEL : PRIMARY_MODEL;
    const res = await callModel(env, model, messages);
    tokensOut += estimateTokens(res.raw);
    if (!res.ok || !res.parsed) {
      await opts.emit({ type: "error", message: `model error: ${res.error ?? "unknown"}` });
      // Force a final synthesis fallback with whatever we have.
      const fallbackAnswer = synthesizePartial(allRowCounts, reg);
      const { annotated, uncited } = flagUncited(fallbackAnswer, reg);
      await opts.emit({ type: "final", answer_markdown: annotated, citations: reg.all(), uncited_sentences: uncited, tokens_in: tokensIn, tokens_out: tokensOut });
      return;
    }

    // --- tool call branch ---
    // When synthesisOnly is active we refuse any further tool_call branches
    // — re-prompt for a final envelope. This prevents the model from
    // blowing past the 8-call cap on a non-compliant retry.
    if (synthesisOnly && res.parsed.tool_call?.name) {
      messages.push({ role: "assistant", content: res.raw });
      messages.push({ role: "user", content: "Tool calls are closed. Reply with {\"final\":{\"answer_markdown\":...}} only." });
      continue;
    }
    if (res.parsed.tool_call?.name) {
      const name = res.parsed.tool_call.name;
      const argsRaw = res.parsed.tool_call.arguments ?? {};
      const args = typeof argsRaw === "object" && argsRaw !== null ? argsRaw as Record<string, unknown> : {};
      const tool = getTool(name);
      if (!tool) {
        messages.push({ role: "assistant", content: res.raw });
        messages.push({ role: "tool", content: JSON.stringify({ error: `unknown tool: ${name}` }) });
        continue;
      }
      // Runtime schema validation — refuse to dispatch the handler when
      // the model produced malformed arguments. Push the error back so
      // the model can correct itself on the next turn (counts against
      // the 8-call cap on purpose so a misbehaving model can't loop).
      const v = validateToolArgs(tool.schema, args);
      if (!v.ok) {
        await opts.emit({ type: "tool_call", name, arguments: args });
        await opts.emit({ type: "tool_result", name, row_count: 0, note: `schema_invalid: ${v.errors.join("; ")}`, took_ms: 0 });
        toolCallsUsed += 1;
        messages.push({ role: "assistant", content: res.raw });
        messages.push({ role: "tool", content: JSON.stringify({ error: "schema_invalid", details: v.errors }) });
        continue;
      }

      const key = await cacheKey(name, args);
      const cached = await cacheGet<{ rows: Array<Record<string, unknown>>; citations: CitationPayload[]; note?: string }>(env, key);
      const t0 = Date.now();
      await opts.emit({ type: "tool_call", name, arguments: args, cached: !!cached });
      toolCallsUsed += 1;

      let result;
      if (cached) {
        result = cached;
      } else {
        try {
          result = await tool.handler(env, args, reg);
        } catch (e) {
          result = { rows: [], citations: [], note: `tool ${name} failed: ${(e as Error).message}` };
        }
        await cachePut(env, key, result);
      }

      // Register every citation the tool produced. The webSearch handler
      // already pre-registers its W:n markers against the shared registry
      // (so multiple webSearch rounds don't collide on idx 0) — for W kind
      // we just emit the (already-stable) marker without re-allocating.
      for (const c of result.citations) {
        const marker = c.kind === "W"
          ? `W:${c.ref_id}`
          : reg.register(c.kind, c.ref_id, c);
        await opts.emit({ type: "citation_registered", marker, payload: reg.get(marker) ?? c });
      }
      allRowCounts.push(result.rows.length);
      await opts.emit({ type: "tool_result", name, row_count: result.rows.length, note: result.note, took_ms: Date.now() - t0 });

      // Feed the result back into the conversation. Truncate big results so
      // the prompt stays small.
      const compact = {
        tool: name,
        rows: result.rows.slice(0, 8),
        total_rows: result.rows.length,
        // Include W markers too so the model knows the exact [W:n] to cite
        // when it sees web results in rows (webSearch handler pre-registers
        // its own W:n markers against the shared registry).
        registered_markers: result.citations.map((c) => `${c.kind}:${c.ref_id}`),
        note: result.note,
      };
      const compactStr = JSON.stringify(compact);
      tokensIn += estimateTokens(compactStr);
      messages.push({ role: "assistant", content: res.raw });
      messages.push({ role: "tool", content: compactStr });
      continue;
    }

    // --- final answer branch ---
    if (res.parsed.final?.answer_markdown) {
      let answer = String(res.parsed.final.answer_markdown);

      // Citation enforcement loop.
      for (let attempt = 0; attempt < MAX_CITATION_RETRIES; attempt++) {
        // Strip any inline markers that don't resolve.
        const markers = CitationRegistry.extractMarkers(answer);
        const orphans = markers.filter((m) => !reg.has(m));
        const sentences = sentenceSplit(answer);
        const offending = sentences.filter((s) => isFactual(s) && citationCount(s) === 0);
        if (orphans.length === 0 && offending.length === 0) break;
        if (deadlineHit()) break;

        const repromptParts: string[] = [];
        if (orphans.length) repromptParts.push(`These citation pills don't resolve to any tool result — remove or replace them: ${orphans.join(", ")}.`);
        if (offending.length) repromptParts.push(`Add a citation pill (e.g. [E:id] [F:id] [N:id] [W:idx]) to each of these factual sentences: ${offending.slice(0, 5).map((s) => `"${s.slice(0, 80)}"`).join("; ")}.`);
        repromptParts.push("Only use markers that correspond to IDs returned by the tools so far. Return strict JSON: {\"final\":{\"answer_markdown\":\"...\"}}.");
        messages.push({ role: "assistant", content: res.raw });
        messages.push({ role: "user", content: repromptParts.join(" ") });
        const retry = await callModel(env, PRIMARY_MODEL, messages);
        tokensOut += estimateTokens(retry.raw);
        if (retry.ok && retry.parsed?.final?.answer_markdown) {
          answer = String(retry.parsed.final.answer_markdown);
        } else {
          break;
        }
      }

      // Final post-processing: strip remaining orphan markers and flag any
      // factual sentence still missing a citation with an inline pill.
      answer = answer.replace(/\[[EFNTRMW]:[^\]]+\]/g, (m) => {
        const key = m.slice(1, -1);
        return reg.has(key) ? m : "";
      });
      const { annotated, uncited } = flagUncited(answer, reg);

      // Auto web fallback: if every tool we called returned zero rows AND no
      // web search was attempted yet, and the optional fallback is on, try
      // one webSearch round so we don't return a hollow answer.
      // Task #5: BRAVE_API_KEY gate removed; webSearch now uses the
      // in-house DuckDuckGo/Mojeek path, which is always available.
      if (opts.autoWebFallback && reg.size() === 0) {
        const ws = getTool("webSearch");
        if (ws && toolCallsUsed < MAX_TOOL_CALLS) {
          const t0 = Date.now();
          await opts.emit({ type: "tool_call", name: "webSearch", arguments: { q: question } });
          toolCallsUsed += 1;
          const r = await ws.handler(env, { q: question }, reg);
          // webSearch pre-registers W markers itself; just surface them.
          for (const c of r.citations) {
            const marker = `W:${c.ref_id}`;
            await opts.emit({ type: "citation_registered", marker, payload: reg.get(marker) ?? c });
          }
          await opts.emit({ type: "tool_result", name: "webSearch", row_count: r.rows.length, note: r.note, took_ms: Date.now() - t0 });
          if (r.rows.length) {
            const banner = "**I don't have this in the database yet — pulling from the web.**\n\n";
            // Use the row's pre-registered marker, not the array index — the
            // registry's webIndex may be non-zero if an earlier loop turn
            // already called webSearch.
            const webList = r.rows.map((row) => `- ${row.title} [${row.marker}]`).join("\n");
            await opts.emit({ type: "final", answer_markdown: banner + (annotated || "") + "\n\n" + webList, citations: reg.all(), uncited_sentences: uncited, tokens_in: tokensIn, tokens_out: tokensOut });
            await emitFollowUps(env, question, annotated, opts);
            return;
          }
        }
      }

      // When the cap forced a synthesis-only turn, the spec requires the
      // result be returned as a `partial` event prefixed with the
      // mandated string — uniform with the deadline branch.
      if (synthesisOnly) {
        const prefixed = `I needed more time — these are the partial results.\n\n${annotated}`;
        await streamAssistantTokens(prefixed, opts);
        await opts.emit({ type: "partial", answer_markdown: prefixed, reason: "tool_cap" });
        await emitFollowUps(env, question, annotated, opts);
        return;
      }
      // Stream the synthesized answer as assistant_token events so SSE
      // consumers can render token-by-token. We chunk on word boundaries
      // to keep the stream lightweight (one event per ~5 words).
      await streamAssistantTokens(annotated, opts);
      await opts.emit({ type: "final", answer_markdown: annotated, citations: reg.all(), uncited_sentences: uncited, tokens_in: tokensIn, tokens_out: tokensOut });
      await emitFollowUps(env, question, annotated, opts);
      return;
    }

    // If synthesisOnly is active but the model still didn't produce a
    // final envelope, fall back to the deterministic partial summary so
    // the cap-overrun contract is honored even on a misbehaving model.
    if (synthesisOnly) {
      const body = synthesizePartial(allRowCounts, reg);
      const { annotated } = flagUncited(body, reg);
      const prefixed = `I needed more time — these are the partial results.\n\n${annotated}`;
      await opts.emit({ type: "partial", answer_markdown: prefixed, reason: "tool_cap" });
      return;
    }

    // Malformed — push back and retry one more time.
    messages.push({ role: "assistant", content: res.raw });
    messages.push({ role: "user", content: "Your previous response was not valid protocol JSON. Reply with exactly one of {\"tool_call\":...} or {\"final\":...}." });
  }
}

// Stream the assistant answer as assistant_token events so the dashboard
// can render token-by-token. Chunked on word boundaries (~5 words/chunk)
// to keep stream volume modest. Best-effort — failure to emit a chunk
// does not block the final event.
async function streamAssistantTokens(text: string, opts: LoopOptions): Promise<void> {
  if (!text) return;
  const words = text.split(/(\s+)/);
  const CHUNK = 10; // ~5 words per chunk (words + separators)
  for (let i = 0; i < words.length; i += CHUNK) {
    const piece = words.slice(i, i + CHUNK).join("");
    if (!piece) continue;
    try { await opts.emit({ type: "assistant_token", text: piece }); }
    catch { return; }
  }
}

function synthesizePartial(rowCounts: number[], reg: CitationRegistry): string {
  const total = rowCounts.reduce((a, b) => a + b, 0);
  if (total === 0) return "I couldn't find any matching rows in the database. Try rephrasing or broaden your filters.";
  const markers = reg.all().slice(0, 10).map((c) => `[${c.marker}]`).join(" ");
  return `Partial results across ${rowCounts.length} tool calls (${total} rows). Surfaced: ${markers}`;
}

async function emitFollowUps(env: Env, question: string, answer: string, opts: LoopOptions): Promise<void> {
  // Best-effort: ask the cheap model for 3 follow-ups in JSON. Skip on
  // failure — follow-ups are a nice-to-have, never block the final answer.
  if (!env.AI) return;
  try {
    const r = (await env.AI.run(PLAN_MODEL, {
      messages: [
        { role: "system", content: "Suggest exactly 3 short follow-up research questions a user would naturally ask next. Reply with JSON {\"questions\":[\"q1\",\"q2\",\"q3\"]} and nothing else." },
        { role: "user", content: `Question: ${question}\n\nAnswer:\n${answer.slice(0, 1500)}` },
      ],
      response_format: { type: "json_object" },
      max_tokens: 250,
    } as Record<string, unknown>)) as { response?: string };
    const raw = typeof r?.response === "string" ? r.response : "";
    try {
      const j = JSON.parse(raw) as { questions?: unknown[] };
      const qs = Array.isArray(j.questions) ? j.questions.filter((q): q is string => typeof q === "string").slice(0, 3) : [];
      if (qs.length) await opts.emit({ type: "follow_ups", questions: qs });
    } catch { /* swallow */ }
  } catch { /* swallow */ }
}

// Re-export for callers that need the manifest.
export { toolManifest, TOOLS };
