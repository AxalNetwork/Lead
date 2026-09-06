// Prior-startup verifier — categorizes the OUTCOME of a claimed prior
// startup using:
//   - deal_events (exits / latest funding)            [Task #1]
//   - sec_form_d_rounds (last Form D filing date)     [Task #2 SEC]
//   - opencorporates_status (dissolved / liquidated)  [optional]
//
// Outcome:
//   - exit:acquired / exit:ipo / exit:spac → deal_event exit
//   - operating → recent (≤24mo) deal or Form D filing
//   - quietly_shut_down → no recent activity AND ≥24mo since last
//     signal, OR corporate-registry status flags dissolved/liquidated
//   - unverifiable → none of the above

import type { Verifier, VerifierResult } from "../types";

export const priorStartupVerifier: Verifier = {
  name: "priorStartup",
  version: "0.2.0",
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

    // 1. deal_events: exit first, else most-recent deal.
    if (companyId) {
      try {
        const exit = await env.DB.prepare(
          // deal_events stores the link as source_url and the date as
           // announcement_date; evidence_url/occurred_at exist on neither.
          `SELECT event_type, source_url AS evidence_url,
                  announcement_date AS occurred_at
             FROM deal_events
            WHERE company_entity_id = ?
              AND event_type IN ('acquisition','ipo','spac')
            ORDER BY announcement_date DESC LIMIT 1`,
        ).bind(companyId).first<{ event_type: string; evidence_url: string | null; occurred_at: string }>();
        if (exit) {
          outcome = `exit:${exit.event_type}`;
          evidenceUrl = exit.evidence_url;
          if (exit.evidence_url) sources.push(exit.evidence_url);
          snippet = `Deal event ${exit.event_type} on ${exit.occurred_at}.`;
        } else {
          const last = await env.DB.prepare(
            `SELECT event_type, source_url AS evidence_url,
                    announcement_date AS occurred_at
               FROM deal_events
              WHERE company_entity_id = ?
              ORDER BY announcement_date DESC LIMIT 1`,
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
      } catch { /* deal_events optional in test DBs */ }

      // 2. SEC Form D — most-recent filing as additional liveness signal.
      // Form D rows linked by entity_id in sec_form_d_rounds (Task #2 SEC).
      try {
        const fd = await env.DB.prepare(
          `SELECT date_of_first_sale FROM sec_form_d_rounds
            WHERE entity_id = ?
            ORDER BY date_of_first_sale DESC LIMIT 1`,
        ).bind(companyId).first<{ date_of_first_sale: string }>();
        if (fd) {
          const ageMs = Date.now() - new Date(fd.date_of_first_sale).getTime();
          const recent = ageMs <= 24 * 30 * 24 * 3600 * 1000;
          // Form D presence upgrades 'quietly_shut_down' to 'operating'
          // when recent, and confirms 'operating' when no deal event found.
          if (recent && (outcome === null || outcome === "quietly_shut_down")) {
            outcome = "operating";
            snippet = (snippet ? snippet + " " : "") + `Form D filed ${fd.date_of_first_sale} (recent).`;
          } else if (!recent && outcome === null) {
            outcome = "quietly_shut_down";
            snippet = `Last Form D ${fd.date_of_first_sale} (>24mo stale).`;
          }
        }
      } catch { /* sec_form_d_rounds optional */ }

      // 3. opencorporates_status (optional table) — dissolved / liquidated forces shutdown.
      try {
        const oc = await env.DB.prepare(
          `SELECT current_status, source_url FROM opencorporates_status WHERE entity_id = ? LIMIT 1`,
        ).bind(companyId).first<{ current_status: string; source_url: string | null }>();
        if (oc && /dissolved|liquidat|inactive|ceased/i.test(oc.current_status ?? "")) {
          outcome = "quietly_shut_down";
          if (oc.source_url) { evidenceUrl = oc.source_url; sources.push(oc.source_url); }
          snippet = (snippet ? snippet + " " : "") + `Registry status: ${oc.current_status}.`;
        }
      } catch { /* opencorporates_status optional */ }
    }

    if (!outcome) {
      return {
        status: "unverifiable",
        confidence: 0.2,
        reason: "no_deal_or_formd_or_registry_signal",
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
