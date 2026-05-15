// Task #45: repo additions kept separate from prospects/repo.ts so the
// large existing file isn't churned. Re-exports `insertAccount` for
// callers that resolve through here.

import type { Env } from "../types";
import { insertAccount, type AccountRow } from "./repo";

export { insertAccount };

export async function getAccountByDomainSafe(env: Env, domain: string): Promise<AccountRow | null> {
  if (!domain) return null;
  const r = await env.DB.prepare(`SELECT * FROM accounts WHERE domain = ? LIMIT 1`).bind(domain).first<AccountRow>();
  return r ?? null;
}
