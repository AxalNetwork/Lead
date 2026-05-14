import { Hono } from "hono";
import type { Env } from "../types";
import { listSectors, listGeographies, resolveSectorSlug, resolveGeoSlug } from "../tax/loader";

export const taxonomies = new Hono<{ Bindings: Env; Variables: { email: string } }>();

taxonomies.get("/sectors", (c) => c.json({ items: listSectors() }));
taxonomies.get("/geographies", (c) => {
  const kind = c.req.query("kind");
  const items = listGeographies().filter((g) => !kind || g.kind === kind);
  return c.json({ items });
});

// Resolve a freeform string to a slug. Useful for the dashboard previews.
taxonomies.get("/resolve", (c) => {
  const q = c.req.query("q") ?? "";
  return c.json({
    sector: resolveSectorSlug(q),
    geography: resolveGeoSlug(q),
  });
});
