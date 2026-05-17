// Task #3: agent HTTP routes.
//
//   POST  /api/agent/ask               → SSE stream of LoopEvents
//   POST  /api/agent/sessions          → create empty session, returns id
//   GET   /api/agent/sessions          → list sessions for the owner
//   GET   /api/agent/sessions/:id      → messages for a session
//   DELETE /api/agent/sessions/:id     → delete session + messages
//
//   POST  /api/agent/saved             → save current research (Q + answer)
//   GET   /api/agent/saved             → list saved research
//   GET   /api/agent/saved/:id         → single saved entry
//   DELETE /api/agent/saved/:id        → delete a saved entry
//
//   GET   /api/agent/budget            → today's token usage
//   GET   /api/agent/tools             → expose the tool manifest (debugging)
//
// All routes filter strictly on owner_email = c.var.email. Single-tenant
// in this deployment (one allowlisted operator), but the schema and the
// queries are tenant-aware so multi-user comes for free later.

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { Env } from "../types";
import { runAgentLoop, MAX_TOOL_CALLS, WALL_CLOCK_MS, toolManifest } from "../agent/loop";
import { getBudget, estimateTokens } from "../agent/budget";

export const agent = new Hono<{ Bindings: Env; Variables: { email: string; request_id: string } }>();

// ---- tool manifest (for the dashboard "16 tools" panel) ---------------------

agent.get("/tools", (c) => c.json({ tools: toolManifest(), max_tool_calls: MAX_TOOL_CALLS, wall_clock_ms: WALL_CLOCK_MS }));

// ---- budget -----------------------------------------------------------------

agent.get("/budget", async (c) => c.json(await getBudget(c.env, c.var.email)));

// ---- sessions ---------------------------------------------------------------

agent.post("/sessions", async (c) => {
  const body = await c.req.json<{ title?: string }>().catch(() => ({} as { title?: string }));
  const id = crypto.randomUUID();
  const title = (body.title ?? "New research").slice(0, 200);
  await c.env.DB.prepare(
    `INSERT INTO agent_sessions (id, owner_email, title) VALUES (?, ?, ?)`,
  ).bind(id, c.var.email, title).run();
  return c.json({ id, title }, 201);
});

agent.get("/sessions", async (c) => {
  // Paginated + searchable. ?q= matches session title OR message content
  // (case-insensitive). ?limit / ?offset for pagination (max 100/page).
  const q = (c.req.query("q") ?? "").trim();
  const limit = Math.min(100, Math.max(1, Number(c.req.query("limit") ?? 50)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));
  const binds: unknown[] = [c.var.email];
  let where = `owner_email = ?`;
  if (q) {
    where += ` AND (LOWER(title) LIKE ? OR id IN (
                 SELECT session_id FROM agent_messages
                  WHERE owner_email = ? AND LOWER(content) LIKE ?
               ))`;
    const like = `%${q.toLowerCase()}%`;
    binds.push(like, c.var.email, like);
  }
  binds.push(limit, offset);
  const r = await c.env.DB.prepare(
    `SELECT id, title, created_at, last_message_at,
            (SELECT COUNT(*) FROM agent_messages m WHERE m.session_id = s.id) AS message_count
       FROM agent_sessions s WHERE ${where}
       ORDER BY last_message_at DESC LIMIT ? OFFSET ?`,
  ).bind(...binds).all();
  const total = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n FROM agent_sessions WHERE owner_email = ?`,
  ).bind(c.var.email).first<{ n: number }>();
  return c.json({ items: r.results ?? [], limit, offset, total: total?.n ?? 0, q });
});

agent.get("/sessions/:id", async (c) => {
  const id = c.req.param("id");
  const sess = await c.env.DB.prepare(`SELECT * FROM agent_sessions WHERE id = ? AND owner_email = ?`).bind(id, c.var.email).first();
  if (!sess) return c.json({ error: "not_found" }, 404);
  // Defense in depth: the session check above already enforces ownership,
  // but we filter messages by owner_email too so a future code path that
  // bypasses the ownership check can't read another tenant's history.
  const msgs = await c.env.DB.prepare(
    `SELECT id, role, content, tool_name, tool_call_json, tool_result_json, citations_json, tokens_in, tokens_out, created_at
       FROM agent_messages WHERE session_id = ? AND owner_email = ? ORDER BY created_at ASC`,
  ).bind(id, c.var.email).all();
  return c.json({ session: sess, messages: msgs.results ?? [] });
});

agent.delete("/sessions/:id", async (c) => {
  await c.env.DB.prepare(`DELETE FROM agent_sessions WHERE id = ? AND owner_email = ?`).bind(c.req.param("id"), c.var.email).run();
  return c.json({ ok: true });
});

// ---- saved research ---------------------------------------------------------

agent.post("/saved", async (c) => {
  const body = await c.req.json<{ title?: string; question: string; answer_markdown: string; citations?: unknown; pinned_entity_ids?: string[]; session_id?: string }>().catch(() => null);
  if (!body || !body.question || !body.answer_markdown) return c.json({ error: "missing_fields" }, 400);
  // Validate session_id ownership when supplied — never let a caller
  // attach a saved-research row to a session they don't own.
  let sessionId: string | null = null;
  if (body.session_id) {
    const own = await c.env.DB.prepare(
      `SELECT id FROM agent_sessions WHERE id = ? AND owner_email = ?`,
    ).bind(body.session_id, c.var.email).first();
    if (!own) return c.json({ error: "invalid_session" }, 403);
    sessionId = body.session_id;
  }
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO saved_research (id, owner_email, title, question, answer_markdown, citations_json, pinned_entity_ids_json, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    id, c.var.email,
    (body.title ?? body.question).slice(0, 200),
    body.question, body.answer_markdown,
    JSON.stringify(body.citations ?? []),
    JSON.stringify(body.pinned_entity_ids ?? []),
    sessionId,
  ).run();
  return c.json({ id }, 201);
});

agent.get("/saved", async (c) => {
  const r = await c.env.DB.prepare(
    `SELECT id, title, question, created_at, last_refreshed_at,
            CASE WHEN diff_json IS NULL THEN 0 ELSE 1 END AS has_diff
       FROM saved_research WHERE owner_email = ? ORDER BY created_at DESC LIMIT 200`,
  ).bind(c.var.email).all();
  return c.json({ items: r.results ?? [] });
});

agent.get("/saved/:id", async (c) => {
  const r = await c.env.DB.prepare(`SELECT * FROM saved_research WHERE id = ? AND owner_email = ?`).bind(c.req.param("id"), c.var.email).first();
  if (!r) return c.json({ error: "not_found" }, 404);
  return c.json(r);
});

agent.delete("/saved/:id", async (c) => {
  await c.env.DB.prepare(`DELETE FROM saved_research WHERE id = ? AND owner_email = ?`).bind(c.req.param("id"), c.var.email).run();
  return c.json({ ok: true });
});

// Manual refresh hook — refreshes EXACTLY the requested saved row (not the
// nightly batch). Ownership is enforced before we dispatch.
agent.post("/saved/:id/refresh", async (c) => {
  const id = c.req.param("id");
  const own = await c.env.DB.prepare(
    `SELECT id FROM saved_research WHERE id = ? AND owner_email = ?`,
  ).bind(id, c.var.email).first();
  if (!own) return c.json({ error: "not_found" }, 404);

  if (c.env.WF_REFRESH_SAVED_RESEARCH) {
    try {
      await c.env.WF_REFRESH_SAVED_RESEARCH.create({ params: { saved_id: id } });
      return c.json({ ok: true, dispatched: "workflow", saved_id: id });
    } catch (e) {
      console.warn("WF_REFRESH_SAVED_RESEARCH.create failed", (e as Error).message);
    }
  }
  // Inline fallback so dev environments still produce a refresh result.
  // CRITICAL: pass saved_id through payload so we refresh ONLY that row,
  // not the nightly "next 50 due" batch.
  const { RefreshSavedResearchWorkflow } = await import("../agent/workflow");
  const wf = new RefreshSavedResearchWorkflow(c.executionCtx, c.env);
  const result = await wf.run({ payload: { saved_id: id } }, {
    do: async (_n, _o, fn) => fn(),
    sleep: async () => undefined,
  });
  return c.json({ dispatched: "inline", saved_id: id, ...result });
});

// ---- ask (SSE) --------------------------------------------------------------

agent.post("/ask", async (c) => {
  const body = await c.req.json<{ question: string; session_id?: string }>().catch(() => null);
  if (!body?.question || typeof body.question !== "string") {
    return c.json({ error: "missing question" }, 400);
  }
  const question = body.question.slice(0, 4000);
  const email = c.var.email;

  // Budget gate first — never spend AI tokens for an over-budget user.
  const budget = await getBudget(c.env, email);
  if (budget.exceeded) {
    return streamSSE(c, async (s) => {
      await s.writeSSE({ event: "budget_exceeded", data: JSON.stringify(budget) });
      await s.writeSSE({ event: "final", data: JSON.stringify({ answer_markdown: `You've used **${budget.used.toLocaleString()}** of your **${budget.cap.toLocaleString()}** daily token budget. Try again after midnight UTC.`, citations: [] }) });
    });
  }

  // Ensure / load session.
  let sessionId = body.session_id ?? null;
  if (sessionId) {
    const own = await c.env.DB.prepare(`SELECT id FROM agent_sessions WHERE id = ? AND owner_email = ?`).bind(sessionId, email).first();
    if (!own) sessionId = null;
  }
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    await c.env.DB.prepare(`INSERT INTO agent_sessions (id, owner_email, title) VALUES (?, ?, ?)`).bind(sessionId, email, question.slice(0, 120)).run();
  }

  // Persist the user turn up front so a refresh recovers it even mid-stream.
  const userMsgId = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO agent_messages (id, session_id, owner_email, role, content, tokens_in) VALUES (?, ?, ?, 'user', ?, ?)`,
  ).bind(userMsgId, sessionId, email, question, estimateTokens(question)).run();

  return streamSSE(c, async (stream) => {
    let cancelled = false;
    stream.onAbort(() => { cancelled = true; });

    // Buffer the assistant turn so we can persist a final summary row,
    // AND persist each tool/system event as its own row as it fires so a
    // mid-stream disconnect doesn't lose the agent-steps trail.
    let assistantAnswer = "";          // updated on final OR partial
    let assistantCitations: unknown[] = [];
    let assistantTokensIn = 0;
    let assistantTokensOut = 0;
    let partialReason: string | null = null;
    const toolEvents: Array<Record<string, unknown>> = [];

    await stream.writeSSE({ event: "session", data: JSON.stringify({ session_id: sessionId }) });
    await stream.writeSSE({ event: "budget", data: JSON.stringify(budget) });

    // Fire-and-forget persistence helper — never blocks the stream and
    // never throws. We deliberately keep these inserts narrow (no body
    // duplication into tool_result_json on the assistant row later).
    const persistEvent = async (role: "tool" | "system", body: {
      tool_name?: string;
      tool_call_json?: unknown;
      tool_result_json?: unknown;
      content?: string;
    }) => {
      try {
        await c.env.DB.prepare(
          `INSERT INTO agent_messages (id, session_id, owner_email, role, content, tool_name, tool_call_json, tool_result_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          crypto.randomUUID(), sessionId, email, role,
          body.content ?? "",
          body.tool_name ?? null,
          body.tool_call_json ? JSON.stringify(body.tool_call_json) : null,
          body.tool_result_json ? JSON.stringify(body.tool_result_json) : null,
        ).run();
      } catch (e) {
        console.warn("agent event persist failed", (e as Error).message);
      }
    };

    try {
      await runAgentLoop(c.env, question, {
        deadlineMs: WALL_CLOCK_MS,
        autoWebFallback: true,
        isCancelled: () => cancelled,
        emit: async (ev) => {
          // Always try to emit to the live stream; if the client is gone,
          // writeSSE will throw and we'll fall through to persistence.
          if (!cancelled) {
            try { await stream.writeSSE({ event: ev.type, data: JSON.stringify(ev) }); }
            catch { cancelled = true; }
          }
          // Per-event persistence — runs even when the client disconnected.
          if (ev.type === "final") {
            assistantAnswer = ev.answer_markdown;
            assistantCitations = ev.citations;
            assistantTokensIn = ev.tokens_in;
            assistantTokensOut = ev.tokens_out;
          } else if (ev.type === "partial") {
            // Capture partial so the persisted row holds the user-visible
            // partial answer (not "(no final answer)"). Final wins if both fire.
            if (!assistantAnswer) {
              assistantAnswer = ev.answer_markdown;
              partialReason = ev.reason;
            }
          } else if (ev.type === "tool_call") {
            toolEvents.push(ev as unknown as Record<string, unknown>);
            await persistEvent("tool", {
              tool_name: ev.name,
              tool_call_json: { arguments: ev.arguments, cached: !!ev.cached },
              content: `tool_call ${ev.name}`,
            });
          } else if (ev.type === "tool_result") {
            toolEvents.push(ev as unknown as Record<string, unknown>);
            await persistEvent("tool", {
              tool_name: ev.name,
              tool_result_json: { row_count: ev.row_count, note: ev.note, took_ms: ev.took_ms },
              content: `tool_result ${ev.name} (${ev.row_count} rows)`,
            });
          } else if (ev.type === "citation_registered") {
            await persistEvent("system", {
              content: `citation ${ev.marker}`,
              tool_result_json: { marker: ev.marker, payload: ev.payload },
            });
          } else if (ev.type === "error") {
            await persistEvent("system", { content: `error: ${ev.message}` });
          } else if (ev.type === "follow_ups") {
            await persistEvent("system", { content: `follow_ups`, tool_result_json: { questions: ev.questions } });
          }
          // assistant_token + partial + final do not get per-event rows —
          // the buffered assistant summary row written after the loop
          // captures the full text + citations + tokens for replay.
        },
      });
    } catch (e) {
      try { await stream.writeSSE({ event: "error", data: JSON.stringify({ message: (e as Error).message }) }); } catch {}
      await persistEvent("system", { content: `loop_error: ${(e as Error).message}` });
    }

    // Final assistant summary row — always written, even when only a
    // partial answer was produced or the stream was aborted mid-flight.
    const assistantMsgId = crypto.randomUUID();
    try {
      await c.env.DB.prepare(
        `INSERT INTO agent_messages (id, session_id, owner_email, role, content, tool_result_json, citations_json, tokens_in, tokens_out)
         VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?)`,
      ).bind(
        assistantMsgId, sessionId, email,
        assistantAnswer || "(no final answer)",
        JSON.stringify({ events: toolEvents, partial_reason: partialReason }),
        JSON.stringify(assistantCitations),
        assistantTokensIn, assistantTokensOut,
      ).run();
      await c.env.DB.prepare(`UPDATE agent_sessions SET last_message_at = datetime('now') WHERE id = ?`).bind(sessionId).run();
    } catch (e) {
      console.warn("agent message persist failed", (e as Error).message);
    }

    try { await stream.writeSSE({ event: "done", data: JSON.stringify({ session_id: sessionId, assistant_message_id: assistantMsgId }) }); } catch {}
  });
});
