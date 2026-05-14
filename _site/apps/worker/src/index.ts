import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./types";
import { health } from "./routes/health";
import { auth } from "./routes/auth";
import { analytics } from "./routes/analytics";
import { leads } from "./routes/leads";
import { accessGuard } from "./middleware/access";

const app = new Hono<{ Bindings: Env; Variables: { email: string } }>();

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (
        origin === "https://app.aidatasignal.com" ||
        origin === "https://aidatasignal.com" ||
        origin.endsWith(".aidatasignal.com")
      ) {
        return origin;
      }
      return null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Cf-Access-Jwt-Assertion"],
  }),
);

app.route("/health", health);
app.use("/api/*", accessGuard);
app.route("/api/auth", auth);
app.route("/api/analytics", analytics);
app.route("/api/leads", leads);

app.notFound((c) => c.json({ error: "not_found" }, 404));
app.onError((err, c) => {
  console.error("Worker error", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default {
  fetch: app.fetch,
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
