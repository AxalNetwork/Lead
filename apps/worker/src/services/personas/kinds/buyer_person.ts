// Task #3: buyer_person kind plugin (legacy "buyer" kind).
//
// Combines: (a) the new u_entities person-graph filter on role IN
// ('buyer','decision_maker','champion'), (b) delegation to the
// person-graph scorer. The legacy `buyers` table is still rescored
// by personas/rescore.ts under the hood; this plugin only governs
// the new u_entities-backed candidate list.

import type { PersonaRow } from "../../../personas/repo";
import { loadPersonEntity, scoreEntityForPersona } from "../../personaMatching";
import type { KindCriteriaPlugin } from "./_generic";

const ROLES = ["buyer", "decision_maker", "champion"];

export const buyerPersonPlugin: KindCriteriaPlugin = {
  kind: "buyer_person",
  defaultEntityFilter(_persona: PersonaRow, opts) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    const ph = ROLES.map(() => "?").join(",");
    return {
      // No role filter when entity_roles lacks buyer-flavored rows yet
      // — fall back to all active person entities. Matches the legacy
      // behavior so existing 'buyer' personas don't regress to empty.
      sql:
        `SELECT e.id FROM u_entities e
          WHERE e.kind = 'person' AND e.status = 'active'
            AND (
              EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id AND r.role IN (${ph}))
              OR NOT EXISTS (SELECT 1 FROM entity_roles r WHERE r.entity_id = e.id)
            )
          ORDER BY e.id LIMIT ? OFFSET ?`,
      binds: [...ROLES, limit, offset],
    };
  },
  async scoreEntity(env, persona, entityId) {
    const entity = await loadPersonEntity(env, entityId);
    if (!entity) return null;
    return await scoreEntityForPersona(env, persona, entity);
  },
  explainMatch(entityId) { return `buyer_person match: entity=${entityId}`; },
};
