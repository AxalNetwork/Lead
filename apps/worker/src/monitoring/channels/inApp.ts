// In-app delivery — the default. Writes the event row and lets the
// dashboard bell pick it up from /api/alerts/unread-count + feed.

import type { Env } from "../../types";

export async function deliverInApp(env: Env, eventId: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const now = new Date().toISOString();
    await env.DB
      .prepare(`UPDATE alert_events SET delivery_status='delivered', delivered_at=?,
                  delivery_attempts=delivery_attempts+1 WHERE id = ?`)
      .bind(now, eventId)
      .run();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
