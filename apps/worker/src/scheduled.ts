import type { Env, JobMessage } from "./types";

interface SourceRow {
  id: string;
  domain: string;
}

/**
 * Cron handler: enqueue a re-scrape for every enabled source whose
 * last_scraped_at is null or older than 24h. Called every 6h via wrangler.toml.
 */
export async function scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  const r = await env.DB.prepare(
    `SELECT id, domain FROM sources
       WHERE enabled = 1
         AND (last_scraped_at IS NULL OR datetime(last_scraped_at) < datetime('now','-24 hours'))
       LIMIT 200`,
  ).all<SourceRow>();
  const rows = r.results ?? [];
  const enqueue = async () => {
    for (const row of rows) {
      const target = `https://${row.domain}/`;
      const jobId = crypto.randomUUID();
      const now = new Date().toISOString();
      try {
        await env.DB.prepare(
          `INSERT INTO jobs (id, name, source, status, kind, target, config_json, started_at, created_at)
           VALUES (?, ?, ?, 'queued', 'url', ?, ?, ?, ?)`,
        )
          .bind(jobId, `cron:${row.domain}`, row.domain, target, JSON.stringify({ trigger: "scheduled" }), now, now)
          .run();
        const msg: JobMessage = { jobId, kind: "url", target };
        await env.LEAD_QUEUE.send(msg);
      } catch (e) {
        console.warn("scheduled enqueue failed", row.domain, (e as Error).message);
      }
    }
  };
  ctx.waitUntil(enqueue());
}
