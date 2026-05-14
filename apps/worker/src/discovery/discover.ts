// Top-level discovery orchestrator. `discoverPartnersForFirm` runs the query
// generators + registry probes in parallel and returns deduped candidate rows.
// The job runner (kind='discover') persists the candidates and may enqueue
// child kind='url' jobs for richer parsing.

import type { Env } from "../types";
import { partnerQueriesForFirm, personaQueries } from "./queries";
import { search } from "./searx";
import { probeAllRegistries } from "./register";

export interface CandidateInput {
  firm_domain: string | null;
  query: string;
  source: string;
  url: string;
  title: string;
  snippet: string;
  name?: string;
  org?: string;
  persona_role?: string;
}

function inferPersonaRole(text: string): string | undefined {
  const t = text.toLowerCase();
  if (t.includes("general partner") || /\bgp\b/.test(t)) return "general_partner";
  if (t.includes("venture partner")) return "venture_partner";
  if (t.includes("managing director") || /\bmd\b/.test(t)) return "managing_director";
  if (t.includes("partner")) return "partner";
  if (t.includes("principal")) return "principal";
  if (t.includes("operating partner")) return "operating_partner";
  return undefined;
}

function inferNameFromLinkedIn(url: string): string | undefined {
  const m = url.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (!m) return undefined;
  return decodeURIComponent(m[1])
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export async function discoverPartnersForFirm(env: Env, firmDomain: string): Promise<CandidateInput[]> {
  const queries = partnerQueriesForFirm(firmDomain);
  const seen = new Set<string>();
  const out: CandidateInput[] = [];

  const searchResults = await Promise.allSettled(queries.map((q) => search(env, q.q, 8).then((hits) => ({ q, hits }))));
  for (const s of searchResults) {
    if (s.status !== "fulfilled") continue;
    for (const h of s.value.hits) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      const persona = inferPersonaRole(h.title + " " + h.snippet);
      const name = inferNameFromLinkedIn(h.url);
      out.push({
        firm_domain: firmDomain,
        query: s.value.q.q,
        source: h.source,
        url: h.url,
        title: h.title,
        snippet: h.snippet,
        name,
        persona_role: persona,
      });
    }
  }

  const registry = await probeAllRegistries(env, firmDomain);
  for (const r of registry) {
    if (seen.has(r.url)) continue;
    seen.add(r.url);
    out.push({
      firm_domain: firmDomain,
      query: `registry:${firmDomain}`,
      source: r.source,
      url: r.url,
      title: r.title,
      snippet: r.snippet,
      org: r.org,
    });
  }

  return out;
}

export async function discoverByPersona(env: Env, persona: string, country?: string): Promise<CandidateInput[]> {
  const queries = personaQueries(persona, country);
  const seen = new Set<string>();
  const out: CandidateInput[] = [];
  const searchResults = await Promise.allSettled(queries.map((q) => search(env, q.q, 8).then((hits) => ({ q, hits }))));
  for (const s of searchResults) {
    if (s.status !== "fulfilled") continue;
    for (const h of s.value.hits) {
      if (seen.has(h.url)) continue;
      seen.add(h.url);
      out.push({
        firm_domain: null,
        query: s.value.q.q,
        source: h.source,
        url: h.url,
        title: h.title,
        snippet: h.snippet,
        name: inferNameFromLinkedIn(h.url),
        persona_role: inferPersonaRole(persona),
      });
    }
  }
  return out;
}
