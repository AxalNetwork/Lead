import { Hono } from "hono";
import type { Env } from "../types";

export const opsCrawlerRoute = new Hono<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }>();

opsCrawlerRoute.get("/", (c) => c.json({ ok: true, message: "ops crawler" }));
