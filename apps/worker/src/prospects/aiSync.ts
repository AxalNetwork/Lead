// Task #45 follow-up: shared account AI re-embed + search index.
// Extracted from routes/prospects.ts so the crawler enrichment workflow
// can call it without pulling the route handler module.

import type { Env } from "../types";
import type { AccountRow } from "./repo";
import { getAccount } from "./repo";
import { indexEntity } from "../ai/search_sync";

export async function syncAccountAi(env: Env, row: AccountRow): Promise<void> {
  try {
    if (env.VEC_ACCOUNTS) {
      const text = [row.name, row.industry, row.description, row.hq_city, row.hq_country_iso2].filter(Boolean).join(" | ");
      const { aiEmbed } = await import("../ai/extract");
      const vec = await aiEmbed(env, text);
      if (vec) {
        await env.VEC_ACCOUNTS.upsert([{ id: row.id, values: vec, metadata: { name: row.name, industry: row.industry ?? "", domain: row.domain ?? "" } }]);
        await env.DB.prepare(`UPDATE accounts SET embedding_dim = ?, embedded_at = ? WHERE id = ?`).bind(vec.length, new Date().toISOString(), row.id).run();
      }
    }
    await indexEntity(env, {
      id: row.id, type: "account", namespace: "axal-accounts",
      title: row.name,
      body: [row.name, row.industry, row.description, row.hq_city, row.hq_country_iso2].filter(Boolean).join(" — "),
      url: row.website ?? undefined,
    });
  } catch (e) {
    console.warn("syncAccountAi failed", row.id, (e as Error).message);
  }
}

export async function syncAccountAiById(env: Env, accountId: string): Promise<void> {
  const row = await getAccount(env, accountId);
  if (row) await syncAccountAi(env, row);
}
