// Task #3: OpenSanctions consolidated matcher.
//
// OpenSanctions exposes a free, no-auth `/match` endpoint that runs a
// single name against the consolidated dataset (OFAC SDN, EU sanctions,
// UN consolidated, UK HMT, Interpol Red Notices, ~250 worldwide lists).
// One call per entity, so this is the workhorse provider for sanctions
// + PEP coverage. Soft daily-cap of 1000 calls; we don't track usage
// here since the dataset is free.
//
// Docs: https://api.opensanctions.org/

import type { Env } from "../../types";

export interface SanctionsMatch {
  id: string;
  schema: string;        // "Person" | "Organization" | "Company"
  caption: string;       // canonical name
  aliases: string[];
  topics: string[];      // e.g. ["sanction", "pep", "crime.terror"]
  datasets: string[];    // e.g. ["us_ofac_sdn", "eu_fsf", "un_sc_sanctions"]
  score: number;         // OpenSanctions' own 0..1 score
  url?: string;
  countries?: string[];
  birth_date?: string;
}

export interface OpenSanctionsResult {
  ok: boolean;
  matches: SanctionsMatch[];
  error?: string;
}

const ENDPOINT = "https://api.opensanctions.org/match/default";

export async function queryOpenSanctions(
  _env: Env,
  candidate: { name: string; schema?: "Person" | "Organization"; aliases?: string[]; birthDate?: string; country?: string },
  opts: { topK?: number; threshold?: number } = {},
): Promise<OpenSanctionsResult> {
  const topK = opts.topK ?? 5;
  const threshold = opts.threshold ?? 0.6;
  const schema = candidate.schema ?? "Person";
  const body = {
    queries: {
      q1: {
        schema,
        properties: {
          name: [candidate.name, ...(candidate.aliases ?? [])].filter(Boolean),
          ...(candidate.birthDate ? { birthDate: [candidate.birthDate] } : {}),
          ...(candidate.country ? { country: [candidate.country] } : {}),
        },
      },
    },
  };
  try {
    const res = await fetch(`${ENDPOINT}?limit=${topK}&threshold=${threshold}`, {
      method: "POST",
      headers: { "content-type": "application/json", "accept": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, matches: [], error: `http_${res.status}` };
    }
    const data = (await res.json()) as { responses?: { q1?: { results?: Array<Record<string, unknown>> } } };
    const results = data?.responses?.q1?.results ?? [];
    const matches: SanctionsMatch[] = results.map((r) => {
      const properties = (r.properties ?? {}) as Record<string, unknown>;
      const aliases = Array.isArray(properties.alias) ? (properties.alias as string[]) : [];
      const countries = Array.isArray(properties.country) ? (properties.country as string[]) : [];
      const birthDates = Array.isArray(properties.birthDate) ? (properties.birthDate as string[]) : [];
      return {
        id: String(r.id ?? ""),
        schema: String(r.schema ?? ""),
        caption: String(r.caption ?? ""),
        aliases,
        topics: Array.isArray(r.topics) ? (r.topics as string[]) : [],
        datasets: Array.isArray(r.datasets) ? (r.datasets as string[]) : [],
        score: Number(r.score ?? 0),
        url: typeof r.id === "string" ? `https://www.opensanctions.org/entities/${r.id}/` : undefined,
        countries,
        birth_date: birthDates[0],
      };
    });
    return { ok: true, matches };
  } catch (e) {
    return { ok: false, matches: [], error: (e as Error).message };
  }
}

// Map dataset slugs returned by OpenSanctions onto our `finding_subtype`
// convention. Keeps the dashboard filter chips meaningful.
export function classifySubtype(datasets: string[]): string {
  const set = new Set(datasets);
  if ([...set].some((d) => d.startsWith("us_ofac"))) return "ofac_sdn";
  if ([...set].some((d) => d.startsWith("eu_fsf") || d === "eu_meps")) return "eu_consolidated";
  if ([...set].some((d) => d.startsWith("un_sc"))) return "un_consolidated";
  if ([...set].some((d) => d.startsWith("gb_hmt"))) return "uk_hmt";
  if ([...set].some((d) => d.startsWith("interpol"))) return "interpol_red";
  return "opensanctions_consolidated";
}

export function isPepHit(topics: string[]): boolean {
  return topics.some((t) => t === "role.pep" || t.startsWith("role.pep") || t === "poi");
}

export function isSanctionHit(topics: string[]): boolean {
  return topics.some((t) => t === "sanction" || t.startsWith("sanction.") || t.startsWith("crime."));
}
