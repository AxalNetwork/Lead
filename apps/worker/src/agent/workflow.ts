// Task #3: nightly refresh workflow for saved_research rows.
//
// Triggered by the `30 4 * * *` cron in scheduled.ts. Walks every saved
// research entry, re-runs the agent loop in a headless mode (no SSE,
// `autoWebFallback=false`), diffs the new answer against the stored
// answer, and writes the result back into `saved_research.diff_json`
// + `last_refreshed_at` + `answer_markdown` (only the diff and refresh
// timestamp; the original answer stays so the user can see what changed).
//
// Cost guard: capped at 50 saved entries per nightly tick. Anything
// older than that is picked up on subsequent nights.

import type { Env } from "../types";
import { runAgentLoop, type LoopEvent } from "./loop";
import { diffAnswers } from "./diff";
import type { CitationMarker } from "./registry";

interface WorkflowStep {
  do<T>(name: string, opts: { retries?: { limit: number; delay?: string; backoff?: "constant" | "linear" | "exponential" } }, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: string | number): Promise<void>;
}
interface WorkflowEvent<P> { payload: P }

const NIGHTLY_LIMIT = 50;

export class RefreshSavedResearchWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }

  async run(_event: WorkflowEvent<Record<string, unknown>>, step: WorkflowStep): Promise<{ ok: true; refreshed: number; skipped: number }> {
    const env = this.env;
    const due = await step.do("load_due", { retries: { limit: 2, backoff: "exponential" } }, async () => {
      const r = await env.DB.prepare(
        `SELECT id, owner_email, question, answer_markdown, citations_json
           FROM saved_research
          ORDER BY COALESCE(last_refreshed_at, '1970-01-01') ASC
          LIMIT ?`,
      ).bind(NIGHTLY_LIMIT).all<{ id: string; owner_email: string; question: string; answer_markdown: string; citations_json: string | null }>();
      return r.results ?? [];
    });

    let refreshed = 0;
    let skipped = 0;
    for (const row of due) {
      try {
        const events: LoopEvent[] = [];
        await runAgentLoop(env, row.question, {
          emit: (ev) => { events.push(ev); },
          autoWebFallback: false,
          deadlineMs: 25_000,
        });
        const final = events.find((e) => e.type === "final");
        if (!final || final.type !== "final") { skipped++; continue; }
        const beforeCitations: CitationMarker[] = (() => {
          try { return JSON.parse(row.citations_json ?? "[]") as CitationMarker[]; }
          catch { return []; }
        })();
        const diff = diffAnswers({ citations: beforeCitations }, { citations: final.citations });
        // Tenant-scoped write — defense in depth. The row was loaded with
        // its owner_email; re-asserting it on the UPDATE means a future
        // multi-tenant workflow trigger can't accidentally overwrite a
        // row across tenants.
        await env.DB.prepare(
          `UPDATE saved_research
              SET answer_markdown   = ?,
                  citations_json    = ?,
                  diff_json         = ?,
                  last_refreshed_at = datetime('now')
            WHERE id = ? AND owner_email = ?`,
        ).bind(final.answer_markdown, JSON.stringify(final.citations), JSON.stringify(diff), row.id, row.owner_email).run();
        refreshed++;
      } catch (e) {
        console.warn("refresh-saved-research failed", row.id, (e as Error).message);
        skipped++;
      }
      // Polite pacing between runs so we don't burn the per-minute AI quota.
      await step.sleep("pace", 500);
    }
    return { ok: true, refreshed, skipped };
  }
}
