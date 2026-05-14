import { Hono } from "hono";
import type { Env } from "../types";

export const health = new Hono<{ Bindings: Env }>();

health.get("/", async (c) => {
  let dbOk = false;
  try {
    const r = await c.env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    dbOk = r?.ok === 1;
  } catch (e) {
    console.error("Health DB check failed", e);
  }
  return c.json({
    status: "ok",
    service: "aidatasignal-worker",
    time: new Date().toISOString(),
    db: dbOk,
  });
});
