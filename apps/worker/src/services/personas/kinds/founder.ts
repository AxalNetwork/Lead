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

function readHint(persona: PersonaRow, field: string): string | null {
  if (!persona.hard_filters_json) return null;
  try {
    const j = JSON.parse(persona.hard_filters_json) as { hints?: Record<string, unknown> };
    const v = j?.hints?.[field];
    return v == null ? null : String(v);
  } catch { return null; }
}

function splitCsv(v: string | null): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export const founderPlugin: KindCriteriaPlugin = {
  kind: "founder",
  defaultEntityFilter(persona: PersonaRow, opts) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);

    // Hints become hard predicates so they actually narrow the
    // candidate set (not just decorate the UI). Roles in entity_roles
    // act as a tag space — domain expertise becomes a 'domain:<slug>'
    // tag, prior_exits / founded_count map to 'exits:N+' / 'founded:N+'
    // synthetic tags that the enrichment pipeline emits per founder.
    const domains = splitCsv(readHint(persona, "domain_expertise"));
    const foundedMin = parseInt(readHint(persona, "founded_count") ?? "", 10);
    const exitsMin = parseInt(readHint(persona, "prior_exits") ?? "", 10);

    const binds: unknown[] = [];
    const rolePh = ROLES.map(() => "?").join(",");
    let sql = `SELECT DISTINCT e.id FROM u_entities e
       JOIN entity_roles r ON r.entity_id = e.id
      WHERE e.kind = 'person' AND e.status = 'active'
        AND r.role IN (${rolePh})`;
    binds.push(...ROLES);

    if (domains.length) {
      const ph = domains.map(() => "?").join(",");
      sql += ` AND EXISTS (SELECT 1 FROM entity_roles rd WHERE rd.entity_id = e.id AND rd.role IN (${ph}))`;
      binds.push(...domains.map((d) => `domain:${d}`));
    }
    if (Number.isFinite(foundedMin) && foundedMin > 0) {
      sql += ` AND EXISTS (SELECT 1 FROM entity_roles rf WHERE rf.entity_id = e.id AND rf.role = ?)`;
      binds.push(`founded:${foundedMin}+`);
    }
    if (Number.isFinite(exitsMin) && exitsMin > 0) {
      sql += ` AND EXISTS (SELECT 1 FROM entity_roles re WHERE re.entity_id = e.id AND re.role = ?)`;
      binds.push(`exits:${exitsMin}+`);
    }

    sql += ` ORDER BY e.id LIMIT ? OFFSET ?`;
    binds.push(limit, offset);
    return { sql, binds };
  },
  async scoreEntity(env, persona, entityId) {
    const entity = await loadPersonEntity(env, entityId);
    if (!entity) return null;
    return await scoreEntityForPersona(env, persona, entity);
  },
  explainMatch(entityId) { return `founder match: entity=${entityId}`; },
};
