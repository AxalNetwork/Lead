// Task #3: investor_firm kind plugin.
//
// Targets entities where kind='fund' (or 'firm' legacy) AND
// entity_roles.role='investor_firm'. The person-graph scorer doesn't
// apply to funds directly; matching here is structural (role + kind
// + AUM/stage hints) and we expose a deterministic surface so the
// dispatcher can present candidates even without per-entity scoring.

import type { PersonaRow } from "../../../personas/repo";
import type { KindCriteriaPlugin } from "./_generic";

export const investorFirmPlugin: KindCriteriaPlugin = {
  kind: "investor_firm",
  defaultEntityFilter(_persona: PersonaRow, opts) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    // Accept both 'fund' (new taxonomy) and 'firm' (legacy u_entities.kind).
    return {
      sql:
        `SELECT DISTINCT e.id FROM u_entities e
           JOIN entity_roles r ON r.entity_id = e.id
          WHERE e.status = 'active'
            AND e.kind IN ('fund','firm')
            AND r.role = 'investor_firm'
          ORDER BY e.id LIMIT ? OFFSET ?`,
      binds: [limit, offset],
    };
  },
  async scoreEntity(_env, _persona, _entityId) {
    // Structural-only match for funds — no per-entity scoring at this
    // tier. Dispatcher treats null as "candidate present, score 0.5".
    return null;
  },
  explainMatch(entityId) {
    return `investor_firm structural match: entity=${entityId} role=investor_firm kind=fund|firm`;
  },
};
