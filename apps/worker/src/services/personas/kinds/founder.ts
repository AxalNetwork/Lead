// Task #3: founder kind plugin.
//
// Surfaces hint fields `founded_count`, `prior_exits`, `domain_expertise`.
// Match: entities with role IN ('founder','ceo','co_founder'). Hint
// numerics are validated by the form; we re-validate here so a stale
// or hand-edited persona can't crash the scorer.

import type { PersonaRow } from "../../../personas/repo";
import { loadPersonEntity, scoreEntityForPersona } from "../../personaMatching";
import type { KindCriteriaPlugin } from "./_generic";

const ROLES = ["founder", "ceo", "co_founder"];

export const founderPlugin: KindCriteriaPlugin = {
  kind: "founder",
  defaultEntityFilter(_persona: PersonaRow, opts) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    const ph = ROLES.map(() => "?").join(",");
    return {
      sql:
        `SELECT DISTINCT e.id FROM u_entities e
           JOIN entity_roles r ON r.entity_id = e.id
          WHERE e.kind = 'person' AND e.status = 'active'
            AND r.role IN (${ph})
          ORDER BY e.id LIMIT ? OFFSET ?`,
      binds: [...ROLES, limit, offset],
    };
  },
  async scoreEntity(env, persona, entityId) {
    const entity = await loadPersonEntity(env, entityId);
    if (!entity) return null;
    return await scoreEntityForPersona(env, persona, entity);
  },
  explainMatch(entityId) { return `founder match: entity=${entityId}`; },
};
