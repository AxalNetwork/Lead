// Task #5: rollup writer + cron marker.
//
// Writes one bucket per metric into health_snapshots. Buckets are
// floored to 5-minute boundaries so multiple writes in the same
// 5-min window collapse via the INSERT-OR-REPLACE primary key.

import type { Env } from "../../types";
import { collectComputePool, collectQueues, collectD1, collectErrorRatePerMin } from "./collectors";

export function bucketStart(now: Date = new Date(), minutes = 5): string {
  // SQLite-comparable timestamp: `YYYY-MM-DD HH:mm:ss` (no `T`, no `Z`)
  // so `bucket_start >= datetime('now','-1 hour')` and `BETWEEN`
  // comparisons work lexicographically the same way SQLite stores
  // text-format datetimes. ISO output here previously caused the
  // sparkline window query to misbehave because `2026-05-20T03:00:00Z`
  // sorts before `2026-05-20 03:00:00`.
  const t = new Date(now);
  t.setSeconds(0, 0);
  const m = t.getMinutes();
  t.setMinutes(m - (m % minutes));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}:00`;
}

async function put(env: Env, bucket: string, metric: string, value: number | null, payload?: Record<string, unknown>): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO health_snapshots (bucket_start, metric_name, value, payload_json)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(bucket_start, metric_name) DO UPDATE SET
         value = excluded.value,
         payload_json = excluded.payload_json`,
    ).bind(bucket, metric, value, payload ? JSON.stringify(payload) : null).run();
  } catch (e) {
    console.warn("health_snapshots write failed", metric, (e as Error).message);
  }
}

export interface WriteSnapshotResult {
  bucket: string;
  metrics_written: number;
}

export async function writeHealthSnapshot(env: Env): Promise<WriteSnapshotResult> {
  const bucket = bucketStart();
  let n = 0;

  // Queues — depth per queue.
  const queues = await collectQueues(env);
  for (const q of queues) {
    await put(env, bucket, `queue.depth.${q.queue_name}`, q.depth, {
      oldest_age_seconds: q.oldest_age_seconds,
      failed_24h: q.failed_24h,
    });
    n++;
    if (q.oldest_age_seconds != null) {
      await put(env, bucket, `queue.oldest_age_seconds.${q.queue_name}`, q.oldest_age_seconds);
      n++;
    }
  }

  // Compute nodes — one gauge per node (1=green, 0=other).
  const nodes = await collectComputePool(env);
  for (const node of nodes) {
    await put(env, bucket, `node.up.${node.id}`, node.status === "green" ? 1 : 0, { status: node.status, name: node.name });
    n++;
  }

  // Error rate per min.
  const erate = await collectErrorRatePerMin(env);
  await put(env, bucket, "errors.per_min", erate);
  n++;

  // D1 throttling 24h.
  const d1 = await collectD1(env);
  await put(env, bucket, "d1.throttled_24h", d1.throttled_24h, { errors_24h: d1.errors_24h });
  n++;

  return { bucket, metrics_written: n };
}

export async function markCronTick(env: Env, cronExpr: string): Promise<void> {
  await put(env, bucketStart(), `cron.tick.${cronExpr}`, 1);
}
