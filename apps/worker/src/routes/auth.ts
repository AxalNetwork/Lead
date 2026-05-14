import { Hono } from "hono";
import type { Env } from "../types";

export const auth = new Hono<{ Bindings: Env; Variables: { email: string } }>();

auth.get("/me", (c) => {
  return c.json({ email: c.get("email"), authenticated: true });
});
