// HostThrottle Durable Object (Task #1: In-House Crawler Engine).
//
// One DO per registered domain. Serializes acquire / recordOutcome /
// recentLog / getHostState calls so per-host politeness state (token
// bucket pacing, robots cache, 429/503 backoff ladder, 1h quarantine)
// cannot race between concurrent fetches of the same host. State is
// persisted to D1 + KV by the underlying hostThrottle helpers; the DO
// adds isolation per host so two parallel callers see a consistent
// view of the bucket / backoff counter.
//
// Caller obtains the stub via:
//   const stub = env.HOST_THROTTLE.get(env.HOST_THROTTLE.idFromName(host));
//   await stub.fetch("https://throttle/acquire", { method: "POST",
//     body: JSON.stringify({ url }) });

import type { Env } from "../types";
import {
  acquire as acquireImpl,
  recordOutcome as recordOutcomeImpl,
  recentLog as recentLogImpl,
  getHostState as getHostStateImpl,
} from "../crawler/hostThrottle";

export class HostThrottle {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(req: Request): Promise<Response> {
    if (req.method !== "POST" && req.method !== "GET") {
      return new Response("method_not_allowed", { status: 405 });
    }
    const url = new URL(req.url);
    const op = url.pathname.replace(/^\/+/, "");
    // Serialize every op through blockConcurrencyWhile so per-host
    // backoff counters can't race on overlapping fetches.
    return this.state.blockConcurrencyWhile(async () => {
      try {
        if (op === "acquire") {
          const body = (await req.json().catch(() => ({}))) as { url?: string };
          if (!body.url) return Response.json({ error: "url_required" }, { status: 400 });
          const r = await acquireImpl(this.env, body.url);
          return Response.json(r);
        }
        if (op === "record_outcome") {
          const body = (await req.json().catch(() => ({}))) as {
            host?: string; ok?: boolean; status?: number; tier_used?: number;
          };
          if (!body.host) return Response.json({ error: "host_required" }, { status: 400 });
          await recordOutcomeImpl(this.env, body.host, {
            ok: Boolean(body.ok),
            status: Number(body.status ?? 0),
            tierUsed: Number(body.tier_used ?? 0),
          });
          return Response.json({ ok: true });
        }
        if (op === "state") {
          const host = url.searchParams.get("host") ?? "";
          if (!host) return Response.json({ error: "host_required" }, { status: 400 });
          const state = await getHostStateImpl(this.env, host);
          return Response.json({ state });
        }
        if (op === "recent_log") {
          const host = url.searchParams.get("host") ?? "";
          const limit = Number(url.searchParams.get("limit") ?? 25);
          if (!host) return Response.json({ error: "host_required" }, { status: 400 });
          const log = await recentLogImpl(this.env, host, limit);
          return Response.json({ log });
        }
        return new Response("not_found", { status: 404 });
      } catch (e) {
        return Response.json({ error: (e as Error).message }, { status: 500 });
      }
    });
  }
}
