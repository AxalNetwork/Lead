// Task #3: Political-donation source adapters.
//
// FEC (US federal) and OpenSecrets are the two primary sources. Both
// require an API key — we gate on env and silently skip when missing.
// A manual-import path also exists via POST /api/profile/:id/donations.

import type { Env } from "../types";

export interface DonationRow {
  entity_id: string;
  donor_name: string | null;
  recipient_name: string;
  recipient_party: string | null;
  recipient_kind: string | null;
  amount_usd: number | null;
  cycle: number | null;
  occurred_at: string | null;
  jurisdiction: string | null;
  source: string;
  source_url: string | null;
  raw: unknown;
}

const UA = "AIDataSignal/1.0 (+https://aidatasignal.com)";

// ---------------- FEC (api.open.fec.gov) ----------------

export async function refreshDonationsFromFec(env: Env, entityId: string): Promise<DonationRow[]> {
  if (!env.FEC_API_KEY) return [];
  const ent = await env.DB.prepare(`SELECT display_name FROM u_entities WHERE id = ?`).bind(entityId).first<{ display_name: string | null }>();
  if (!ent?.display_name) return [];
  try {
    const url = `https://api.open.fec.gov/v1/schedules/schedule_a/?api_key=${encodeURIComponent(env.FEC_API_KEY)}&contributor_name=${encodeURIComponent(ent.display_name)}&per_page=50&sort=-contribution_receipt_date`;
    const res = await fetch(url, { headers: { "user-agent": UA, accept: "application/json" } });
    if (!res.ok) return [];
    const j = await res.json() as { results?: Array<{ contribution_receipt_amount?: number; contribution_receipt_date?: string; committee?: { name?: string; party_full?: string; committee_type_full?: string }; election_type?: string; report_year?: number; pdf_url?: string }> };
    return (j.results ?? []).map((r) => ({
      entity_id: entityId,
      donor_name: ent.display_name,
      recipient_name: r.committee?.name ?? "(unknown committee)",
      recipient_party: r.committee?.party_full ?? null,
      recipient_kind: classifyCommitteeKind(r.committee?.committee_type_full ?? null),
      amount_usd: typeof r.contribution_receipt_amount === "number" ? r.contribution_receipt_amount : null,
      cycle: r.report_year ?? null,
      occurred_at: r.contribution_receipt_date ?? null,
      jurisdiction: "US-federal",
      source: "fec",
      source_url: r.pdf_url ?? null,
      raw: r,
    }));
  } catch (e) {
    console.warn("FEC fetch failed", entityId, (e as Error).message);
    return [];
  }
}

function classifyCommitteeKind(s: string | null): string | null {
  if (!s) return null;
  const t = s.toLowerCase();
  if (t.includes("super")) return "super_pac";
  if (t.includes("party")) return "party_cmte";
  if (t.includes("pac")) return "pac";
  if (t.includes("candidate")) return "candidate";
  return null;
}

// ---------------- OpenSecrets (stub) ----------------

export async function refreshDonationsFromOpenSecrets(env: Env, entityId: string): Promise<DonationRow[]> {
  if (!env.OPENSECRETS_API_KEY) return [];
  // OpenSecrets requires a CRPID lookup first. Keeping the adapter as
  // a stub until the CRPID resolver is wired — matches the FEC shape
  // when it ships.
  void entityId;
  return [];
}

// ---------------- Orchestrator ----------------

export async function refreshDonations(env: Env, entityId: string): Promise<{ source_counts: Record<string, number>; total: number; upserted: number }> {
  const sources: Array<[string, () => Promise<DonationRow[]>]> = [
    ["fec", () => refreshDonationsFromFec(env, entityId)],
    ["opensecrets", () => refreshDonationsFromOpenSecrets(env, entityId)],
  ];
  const counts: Record<string, number> = {};
  const all: DonationRow[] = [];
  for (const [name, fn] of sources) {
    try { const rows = await fn(); counts[name] = rows.length; all.push(...rows); }
    catch (e) { counts[name] = 0; console.warn(`donation adapter ${name} failed`, (e as Error).message); }
  }
  let upserted = 0;
  for (const r of all) {
    try {
      await env.DB.prepare(
        `INSERT INTO political_donations
           (id, entity_id, donor_name, recipient_name, recipient_party, recipient_kind, amount_usd, cycle, occurred_at, jurisdiction, source, source_url, raw_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(entity_id, source, recipient_name, occurred_at, amount_usd) DO NOTHING`,
      ).bind(
        crypto.randomUUID(), r.entity_id, r.donor_name, r.recipient_name, r.recipient_party,
        r.recipient_kind, r.amount_usd, r.cycle, r.occurred_at, r.jurisdiction,
        r.source, r.source_url, r.raw ? JSON.stringify(r.raw).slice(0, 4000) : null,
      ).run();
      upserted++;
    } catch (e) {
      console.warn("donation upsert failed", entityId, r.recipient_name, (e as Error).message);
    }
  }
  return { source_counts: counts, total: all.length, upserted };
}
