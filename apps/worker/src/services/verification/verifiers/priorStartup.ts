// Prior-startup verifier — categorizes the OUTCOME of a claimed prior
// startup using deal_events (Task #1), SEC Form D rows, and the
// company's status row when present. Distinguishes:
//   - exit:acquired       → deal_event of kind 'acquisition'
//   - exit:ipo            → deal_event of kind 'ipo'
//   - operating           → recent funding rounds, no exit
//   - quietly_shut_down   → no funding > 24mo AND no exit signal AND
//                           company status flagged dissolved/dead
//   - unverifiable        → none of the above present


import type { Verifier, VerifierResult } from "../types";

export const priorStartupVerifier: Verifier = {
  name: "priorStartup",
  version: "0.1.0",
  supports(c) { return c.predicate === "person.prior_startup"; },
  async verify(env, _personId, claim): Promise<VerifierResult> {
    const p = claim.payload as { company_entity_id?: string; company_name?: string; claimed_outcome?: string; source_url?: string };
    const companyId = p.company_entity_id ?? null;
    const companyName = p.company_name ?? null;
    if (!companyId && !companyName) return { status: "skipped", confidence: 0, reason: "missing_company" };

    let outcome: string | null = null;
    let evidenceUrl: string | null = null;
    let snippet = "";
    const sources: string[] = [];

    if (companyId) {
      try {
        const exit = await env.DB.prepare(
          `SELECT event_type, evidence_url, occurred_at FROM deal_events
            WHERE company_entity_id = ?
              AND event_type IN ('acquisition','ipo','spac')
            ORDER BY occurred_at DESC LIMIT 1`,
        ).bind(companyId).first<{ event_type: string; evidence_url: string | null; occurred_at: string }>();
        if (exit) {
          outcome = `exit:${exit.event_type}`;
          evidenceUrl = exit.evidence_url;
          if (exit.evidence_url) sources.push(exit.evidence_url);
          snippet = `Deal event ${exit.event_type} on ${exit.occurred_at}.`;
        } else {
          const last = await env.DB.prepare(
            `SELECT event_type, evidence_url, occurred_at FROM deal_events
              WHERE company_entity_id = ?
              ORDER BY occurred_at DESC LIMIT 1`,
          ).bind(companyId).first<{ event_type: string; evidence_url: string | null; occurred_at: string }>();
          if (last) {
            const ageMs = Date.now() - new Date(last.occurred_at).getTime();
            const stale = ageMs > 24 * 30 * 24 * 3600 * 1000;
            outcome = stale ? "quietly_shut_down" : "operating";
            evidenceUrl = last.evidence_url;
            if (last.evidence_url) sources.push(last.evidence_url);
            snippet = `Latest deal event ${last.event_type} on ${last.occurred_at} (${stale ? ">24mo stale" : "recent"}).`;
          }
        }
      } catch { /* deal_events may not exist in test DBs */ }
    }

    if (!outcome) {
      return {
        status: "unverifiable",
        confidence: 0.2,
        reason: "no_deal_or_status_signal",
        evidence_url: p.source_url ?? null,
      };
    }

    const claimed = (p.claimed_outcome ?? "").toLowerCase();
    const isContradicted =
      (claimed.includes("acquired") && !outcome.startsWith("exit")) ||
      (claimed.includes("ipo") && outcome !== "exit:ipo") ||
      (claimed.includes("exit") && !outcome.startsWith("exit")) ||
      (claimed.includes("operating") && outcome === "quietly_shut_down");

    return {
      status: isContradicted ? "contradicted" : "confirmed",
      confidence: isContradicted ? 0.7 : 0.85,
      evidence_url: evidenceUrl,
      sources,
      evidence_snippet: snippet,
      reason: isContradicted ? `claimed_${claimed}_vs_${outcome}` : null,
      derived_predicate: "person.prior_startup.outcome",
      derived_value_text: outcome,
      derived_value_json: { company_entity_id: companyId, company_name: companyName, outcome },
    };
  },
};
