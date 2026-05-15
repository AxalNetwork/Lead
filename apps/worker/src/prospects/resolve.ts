// Task #45: account resolution for crawler-emitted events.
//
// Resolution chain:
//   1. exact-domain lookup (`accounts.domain = ?`)
//   2. vector @ 0.85 (VEC_ACCOUNTS) when available
//   3. AI arbitration on borderline vector matches (0.82-0.85)
//   4. otherwise INSERT a new account
//
// Returns { id, created } so callers can bump crawler_runs counters.

import type { Env } from "../types";
import { aiEmbed, aiArbitrate } from "../ai/extract";
import { assertBudget } from "../ai/budget";
import { trackVectorize } from "../analytics/events";
import { insertAccount, getAccountByDomainSafe } from "./repo_extras";
import type { AccountHint } from "./sources/_types";
import { apexDomain } from "./sources/_helpers";

const SIM_AUTO_MERGE = 0.85;
const SIM_REVIEW = 0.82;

export interface ResolveResult {
  id: string;
  created: boolean;
  matchedBy: "domain" | "vector" | "vector_arbitrated" | "name" | "created";
  score?: number;
}

export async function resolveAccount(env: Env, hint: AccountHint, source: string): Promise<ResolveResult | null> {
  const domain = apexDomain(hint.domain ?? hint.website ?? null);

  // 1. exact domain (the only high-confidence deterministic match —
  // exact-name is intentionally NOT used here because two unrelated
  // accounts can legitimately share a common short name.)
  if (domain) {
    const row = await getAccountByDomainSafe(env, domain);
    if (row) return { id: row.id, created: false, matchedBy: "domain" };
  }

  // 2. vector (semantic match against embedded account corpus)
  if (env.VEC_ACCOUNTS) {
    const text = [hint.name, hint.industry, hint.description, hint.hq_city, hint.hq_country_iso2, domain].filter(Boolean).join(" | ");
    if (text) {
      const vec = await aiEmbed(env, text);
      if (vec) {
        const ok = await assertBudget(env, "vectorize");
        if (ok.ok) {
          try {
            const r = await env.VEC_ACCOUNTS.query(vec, { topK: 5, returnMetadata: "all" });
            trackVectorize(env, { op: "query", index: "companies" });
            const best = r.matches?.[0];
            if (best) {
              if (best.score >= SIM_AUTO_MERGE) {
                return { id: best.id, created: false, matchedBy: "vector", score: best.score };
              }
              if (best.score >= SIM_REVIEW) {
                const arb = await aiArbitrate(env, text, JSON.stringify(best.metadata ?? {}));
                if (arb.match === "yes" && arb.confidence >= 0.85) {
                  return { id: best.id, created: false, matchedBy: "vector_arbitrated", score: best.score };
                }
              }
            }
          } catch (e) {
            console.warn("resolveAccount vector failed", (e as Error).message);
          }
        }
      }
    }
  }

  // 3. exact-name fallback ONLY when both no domain hint and no vector
  // hit — narrow window to keep merges safe. Requires the candidate to
  // have no domain set so we don't collide a "stripe" cafe with stripe.com.
  if (!domain && hint.name) {
    const row = await env.DB.prepare(
      `SELECT id FROM accounts WHERE lower(name) = lower(?) AND domain IS NULL LIMIT 1`,
    ).bind(hint.name).first<{ id: string }>();
    if (row) return { id: row.id, created: false, matchedBy: "name" };
  }

  // 4. create
  const name = (hint.name ?? domain ?? "").trim();
  if (!name) return null;
  try {
    const created = await insertAccount(env, {
      name,
      domain: domain ?? null,
      website: hint.website ?? (domain ? `https://${domain}` : null),
      description: hint.description ?? null,
      industry: hint.industry ?? null,
      hq_country_iso2: hint.hq_country_iso2 ?? null,
      hq_city: hint.hq_city ?? null,
      linkedin_url: hint.linkedin_url ?? null,
      github_org: hint.github_org ?? null,
      imported_from: `crawler:${source}`,
    } as Parameters<typeof insertAccount>[1], `crawler:${source}`);
    return { id: created.id, created: true, matchedBy: "created" };
  } catch (e) {
    console.warn("resolveAccount insertAccount failed", name, (e as Error).message);
    // If the insert raced with a parallel crawler, fall through to a
    // domain re-lookup so we still attach the signal.
    if (domain) {
      const row = await getAccountByDomainSafe(env, domain);
      if (row) return { id: row.id, created: false, matchedBy: "domain" };
    }
    return null;
  }
}
