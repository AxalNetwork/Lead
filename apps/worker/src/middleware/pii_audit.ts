// Middleware for /api/leads/:id GET — after the handler responds with JSON,
// write a pii_access_log row capturing which PII fields were actually
// returned. The `reason` is read from the X-PII-Reason header (default
// 'ui:detail'). Skipped for non-200 responses and non-JSON.

import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";
import { logPiiAccess, piiFieldsPresent } from "../compliance/audit";

export const piiAuditOnLeadGet: MiddlewareHandler<{ Bindings: Env; Variables: { email: string } }> = async (c, next) => {
  await next();
  if (c.req.method !== "GET") return;
  const id = c.req.param("id");
  if (!id) return;
  const path = new URL(c.req.url).pathname;
  if (!/^\/api\/leads\/[^/]+\/?$/.test(path)) return; // only the detail route, not history/etc
  const status = c.res.status;
  if (status !== 200) return;
  const ct = c.res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) return;

  // Clone the response body so we can inspect it without consuming the original.
  const cloned = c.res.clone();
  let body: Record<string, unknown> | null = null;
  try { body = (await cloned.json()) as Record<string, unknown>; } catch { return; }
  if (!body) return;
  const fields = piiFieldsPresent(body);
  const user = c.get("email") || "unknown";
  const reason = c.req.header("X-PII-Reason") || "ui:detail";
  const ip = c.req.header("CF-Connecting-IP") || c.req.header("X-Forwarded-For") || null;
  const ua = c.req.header("User-Agent") || null;
  try {
    await logPiiAccess(c.env, { user_email: user, lead_id: id, fields, reason, ip, ua });
  } catch (e) {
    console.warn("pii_access_log insert failed", (e as Error).message);
  }
};
