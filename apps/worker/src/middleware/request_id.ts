// Task #27: per-request tracing.
//
// Every inbound request gets a stable request_id (X-Request-Id header is
// honored if present, otherwise we mint a new UUID). The id is:
//   - exposed on the Hono context as c.var.request_id,
//   - returned to the client in X-Request-Id,
//   - referenced in error_log rows so a 500 response and its log row can be
//     pivoted from one to the other in the dashboard.

import type { MiddlewareHandler } from "hono";

export const requestId: MiddlewareHandler<{ Variables: { request_id: string } }> = async (c, next) => {
  const incoming = c.req.header("X-Request-Id");
  const id = incoming && /^[A-Za-z0-9_\-]{6,64}$/.test(incoming) ? incoming : crypto.randomUUID();
  c.set("request_id", id);
  c.header("X-Request-Id", id);
  await next();
};
