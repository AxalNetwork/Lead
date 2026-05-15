// Task #45: per-source crawl runner.
//
// Invoked by the CrawlSignalsWorkflow class (and by the
// /api/crawlers/:slug/run admin endpoint). Walks one source module
// end-to-end:
//
//   1. recordRun → write a `running` row in crawler_runs
//   2. crawl()   → emit drafts
//   3. resolveAccount → exact-domain → vector → arbitration → create
//   4. insertSignal   → with R2 key + evidence snippet
//   5. recompute account_score for accounts that received signals
//   6. update crawler_runs row with final counters + cursor

import type { Env } from "../types";
import type { SignalEventDraft, SourceModule } from "./sources/_types";
import { getCursor, setCursor, isEnabled } from "./sources/_helpers";
import { resolveAccount } from "./resolve";
import { insertSignal, recomputeAccountScore, listBuyers, insertBuyer } from "./repo";

export interface RunOutcome {
  runId: string;
  source: string;
  status: "ok" | "partial" | "error" | "disabled";
  events_emitted: number;
  signals_inserted: number;
  signals_skipped: number;
  accounts_created: number;
  accounts_resolved: number;
  error?: string;
}

const MAX_EVENTS_PER_RUN = 500;

export async function runSource(env: Env, mod: SourceModule, opts?: { force?: boolean; accountId?: string }): Promise<RunOutcome> {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const enabled = opts?.force ? true : await isEnabled(env, mod.slug, mod.enabledByDefault);
  const envReady = !mod.requiresEnv || Boolean((env as unknown as Record<string, unknown>)[mod.requiresEnv as string]);

  const startStmt = env.DB.prepare(
    `INSERT INTO crawler_runs (id, source, started_at, status) VALUES (?, ?, ?, ?)`,
  ).bind(runId, mod.slug, startedAt, enabled && envReady ? "running" : "disabled");
  await startStmt.run().catch((e) => console.warn("crawler_runs insert failed", e.message));

  if (!enabled || !envReady) {
    await finalize(env, runId, "disabled", { events: 0, inserted: 0, skipped: 0, created: 0, resolved: 0, cursor: null, error: enabled ? `missing_env:${String(mod.requiresEnv)}` : "disabled" });
    return { runId, source: mod.slug, status: "disabled", events_emitted: 0, signals_inserted: 0, signals_skipped: 0, accounts_created: 0, accounts_resolved: 0 };
  }

  const cursor = await getCursor(env, mod.slug);
  let drafts: SignalEventDraft[] = [];
  let nextCursor: string | null | undefined = cursor;
  let crawlError: string | undefined;
  try {
    const r = await mod.crawl({ env, cursor, maxEvents: MAX_EVENTS_PER_RUN, accountId: opts?.accountId });
    drafts = (r.events ?? []).slice(0, MAX_EVENTS_PER_RUN);
    nextCursor = r.cursor === undefined ? cursor : r.cursor;
  } catch (e) {
    crawlError = (e as Error).message;
  }

  let inserted = 0;
  let skipped = 0;
  let created = 0;
  let resolved = 0;
  const touched = new Set<string>();
  for (const d of drafts) {
    try {
      const acct = await resolveAccount(env, d.account, mod.slug);
      if (!acct) { skipped += 1; continue; }
      if (acct.created) created += 1; else resolved += 1;
      // r2_key + evidence_snippet land in the same INSERT so we never
      // race a follow-up UPDATE against another crawler writing the same
      // (account, source, evidence_url) tuple.
      await insertSignal(env, {
        account_id: acct.id,
        kind: d.kind,
        source: mod.slug,
        weight: d.weight ?? null,
        confidence: d.confidence ?? null,
        payload_json: d.payload != null ? JSON.stringify(d.payload) : null,
        evidence_url: d.evidence_url ?? null,
        occurred_at: d.occurred_at ?? null,
        r2_key: d.r2_key ?? null,
        evidence_snippet: d.evidence_snippet ?? null,
      });
      inserted += 1;
      touched.add(acct.id);

      // Buyer routing: when the source attached a buyer, upsert by
      // email (or LinkedIn URL) so leadership_change signals immediately
      // create a contact record on the account.
      if (d.buyer && (d.buyer.email || d.buyer.linkedin_url || d.buyer.name)) {
        try {
          const existing = await listBuyers(env, acct.id);
          const match = existing.find((b) =>
            (d.buyer!.email && b.email && b.email.toLowerCase() === d.buyer!.email!.toLowerCase()) ||
            (d.buyer!.linkedin_url && b.linkedin_url && b.linkedin_url === d.buyer!.linkedin_url),
          );
          if (!match) {
            const created = await insertBuyer(env, {
              account_id: acct.id,
              name: d.buyer.name ?? null,
              email: d.buyer.email ?? null,
              title: d.buyer.title ?? null,
              linkedin_url: d.buyer.linkedin_url ?? null,
            });
            // Hand off to the existing lead-enrichment workflow so the
            // new buyer goes through the same hydration path as a
            // form-captured lead (Hunter, Proxycurl, fit scoring, …).
            if (env.WF_ENRICH_LEAD) {
              env.WF_ENRICH_LEAD.create({ params: { buyerId: created.id, accountId: acct.id, source: mod.slug } })
                .catch((e) => console.warn("WF_ENRICH_LEAD enqueue failed", created.id, (e as Error).message));
            }
          }
        } catch (e) { console.warn("buyer upsert failed", acct.id, (e as Error).message); }
      }
    } catch (e) {
      const msg = (e as Error).message ?? "";
      // UNIQUE-index conflict = already-seen signal; count as skip not error.
      if (msg.includes("UNIQUE") || msg.includes("constraint")) skipped += 1;
      else { skipped += 1; console.warn("runSource insert failed", mod.slug, msg); }
    }
  }

  // Recompute account scores for everyone we touched.
  for (const id of touched) {
    try { await recomputeAccountScore(env, id); } catch (e) { console.warn("score recompute failed", id, (e as Error).message); }
  }

  if (nextCursor) await setCursor(env, mod.slug, nextCursor);

  const status: RunOutcome["status"] = crawlError ? "error" : (skipped > 0 && inserted === 0 ? "partial" : "ok");
  await finalize(env, runId, status, { events: drafts.length, inserted, skipped, created, resolved, cursor: nextCursor ?? null, error: crawlError });

  return { runId, source: mod.slug, status, events_emitted: drafts.length, signals_inserted: inserted, signals_skipped: skipped, accounts_created: created, accounts_resolved: resolved, error: crawlError };
}

async function finalize(env: Env, runId: string, status: string, m: { events: number; inserted: number; skipped: number; created: number; resolved: number; cursor: string | null; error?: string }): Promise<void> {
  await env.DB.prepare(
    `UPDATE crawler_runs SET finished_at = ?, status = ?, events_emitted = ?, signals_inserted = ?, signals_skipped = ?, accounts_created = ?, accounts_resolved = ?, cursor = ?, error = ? WHERE id = ?`,
  ).bind(new Date().toISOString(), status, m.events, m.inserted, m.skipped, m.created, m.resolved, m.cursor, m.error ?? null, runId)
    .run().catch((e) => console.warn("crawler_runs finalize failed", e.message));
}
