// Task #3: venture_partner kind plugin.
//
// Honours the per-kind hint `subtype` ∈ {lawyer, banker, operator,
// politician, scout, advisor, board_member}. When subtype is set, we
// also accept entity_roles.role = subtype so e.g.
// venture_partner.subtype='lawyer' selects entities with role='lawyer'
// + tags containing startup_law / securities / patent.

import type { PersonaRow } from "../../../personas/repo";
import { loadPersonEntity, scoreEntityForPersona } from "../../personaMatching";
import type { KindCriteriaPlugin } from "./_generic";

function readHint(persona: PersonaRow, field: string): string | null {
  // Hints live under hard_filters_json.hints.<field> so we don't need
  // a schema migration for every new hint type.
  if (!persona.hard_filters_json) return null;
  try {
    const j = JSON.parse(persona.hard_filters_json) as { hints?: Record<string, unknown> };
    const v = j?.hints?.[field];
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
}

const BASE_ROLES = ["venture_partner", "advisor", "scout"];

export const venturePartnerPlugin: KindCriteriaPlugin = {
  kind: "venture_partner",
  defaultEntityFilter(persona, opts) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    const subtype = readHint(persona, "subtype");
    const roles = subtype ? Array.from(new Set([...BASE_ROLES, subtype])) : BASE_ROLES;
    const ph = roles.map(() => "?").join(",");
    return {
      sql:
        `SELECT DISTINCT e.id FROM u_entities e
           JOIN entity_roles r ON r.entity_id = e.id
          WHERE e.kind = 'person' AND e.status = 'active'
            AND r.role IN (${ph})
          ORDER BY e.id LIMIT ? OFFSET ?`,
      binds: [...roles, limit, offset],
    };
  },
  async scoreEntity(env, persona, entityId) {
    const entity = await loadPersonEntity(env, entityId);
    if (!entity) return null;
    return await scoreEntityForPersona(env, persona, entity);
  },
  explainMatch(entityId) {
    return `venture_partner match: entity=${entityId}`;
  },
};
