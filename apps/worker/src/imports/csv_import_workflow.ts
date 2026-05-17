// Task #3: CsvImportWorkflow — durable per-import workflow that wraps
// processCsvImport with Cloudflare Workflows checkpoint+resume semantics.
//
// Each `step.do` is the next 5,000-row chunk; the step's idempotency
// + retry policy gives us automatic resumption from the latest
// `csv_imports.processed_rows` cursor without re-doing finished work.
// The workflow exits when processCsvImport reports the import is no
// longer in 'processing' state (i.e. status flipped to 'completed',
// 'failed', or 'needs_manual_mapping').
import type { Env } from "../types";
import { processCsvImport } from "./csv_import";

interface WorkflowStep {
  do<T>(name: string, opts: { retries?: { limit: number; delay?: string; backoff?: "constant" | "linear" | "exponential" } }, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, durationMs: string | number): Promise<void>;
}
interface WorkflowEvent<P> { payload: P }

export class CsvImportWorkflow {
  env: Env;
  ctx: ExecutionContext;
  constructor(ctx: ExecutionContext, env: Env) { this.ctx = ctx; this.env = env; }
  async run(event: WorkflowEvent<{ importId: string }>, step: WorkflowStep): Promise<{ ok: true; importId: string }> {
    const { importId } = event.payload;
    // Cap at 200 chunks of 5,000 rows = 1,000,000 row hard ceiling per
    // workflow so a runaway import can't loop forever. Each chunk is a
    // separate step with up to 3 retries (exponential backoff).
    for (let i = 0; i < 200; i++) {
      const done = await step.do(`chunk-${i}`, { retries: { limit: 3, backoff: "exponential" } }, async () => {
        await processCsvImport(this.env, importId, { insideWorkflow: true });
        const row = await this.env.DB.prepare("SELECT status FROM csv_imports WHERE id = ?")
          .bind(importId).first<{ status: string }>();
        return row?.status !== "processing";
      });
      if (done) break;
      await step.sleep(`pace-${i}`, "1 second");
    }
    return { ok: true, importId };
  }
}
