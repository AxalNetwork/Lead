import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { health } from "./routes/health";
import { auth } from "./routes/auth";
import { analytics } from "./routes/analytics";
import { leads } from "./routes/leads";
import { exports_ } from "./routes/exports";
import { accessGuard } from "./middleware/access";
import { renderLanding } from "./landing";
import { renderDashboard } from "./dashboard";

const PUBLIC_HOSTS = new Set(["aidatasignal.com", "www.aidatasignal.com"]);
const APP_HOST = "app.aidatasignal.com";
const API_HOST = "api.aidatasignal.com";

const api = new Hono<{ Bindings: Env; Variables: { email: string } }>();

api.use(
  "*",
  cors({
    origin: (origin) => {
      const allowed = new Set([
        "https://app.aidatasignal.com",
        "https://aidatasignal.com",
        "https://www.aidatasignal.com",
      ]);
      if (origin && allowed.has(origin)) return origin;
      return null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Cf-Access-Jwt-Assertion"],
  }),
);

api.route("/health", health);
api.use("/api/*", accessGuard);
api.route("/api/auth", auth);
api.route("/api/analytics", analytics);
api.route("/api/leads", leads);
api.route("/api/exports", exports_);

api.notFound((c) => c.json({ error: "not_found" }, 404));
api.onError((err, c) => {
  console.error("Worker error", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

const dashboardApp = new Hono<{ Bindings: Env; Variables: { email: string } }>();
dashboardApp.use("*", accessGuard);
dashboardApp.get("*", (c) => renderDashboard(c.get("email")));

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);
    const host = url.hostname.toLowerCase();

    if (PUBLIC_HOSTS.has(host)) {
      if (url.pathname === "/" || url.pathname === "") return renderLanding();
      if (url.pathname === "/robots.txt") {
        return new Response("User-agent: *\nAllow: /\n", { headers: { "Content-Type": "text/plain" } });
      }
      return new Response("Not found", { status: 404 });
    }

    if (host === APP_HOST) {
      return dashboardApp.fetch(req, env, ctx);
    }

    if (host === API_HOST) {
      return api.fetch(req, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
  async queue(batch: MessageBatch<unknown>, env: Env) {
    for (const msg of batch.messages) {
      try {
        console.log("Queue message", msg.id, msg.body);
        msg.ack();
      } catch (e) {
        console.error("Queue handler error", e);
        msg.retry();
      }
    }
    void env;
  },
};
