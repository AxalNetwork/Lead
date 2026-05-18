// Task #3: investor_firm kind plugin.
//
// Targets entities where kind='fund' (or 'firm' legacy) AND
// entity_roles.role='investor_firm'. The person-graph scorer doesn't
// apply to funds directly; matching here is structural (role + kind
// + AUM/stage hints) and we expose a deterministic surface so the
// dispatcher can present candidates even without per-entity scoring.

import type { PersonaRow } from "../../../personas/repo";
import type { KindCriteriaPlugin } from "./_generic";

// Read a hint value from hard_filters_json.hints.<field>.
function readHint(persona: PersonaRow, field: string): string | null {
  if (!persona.hard_filters_json) return null;
  try {
    const j = JSON.parse(persona.hard_filters_json) as { hints?: Record<string, unknown> };
    const v = j?.hints?.[field];
    return typeof v === "string" && v ? v : null;
  } catch { return null; }
}

// Split a comma-separated hint value into trimmed tokens.
function splitCsv(v: string | null): string[] {
  return v ? v.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

export const investorFirmPlugin: KindCriteriaPlugin = {
  kind: "investor_firm",
  defaultEntityFilter(persona: PersonaRow, opts) {
    const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
    const offset = Math.max(0, opts?.offset ?? 0);
    // Roles in entity_roles act as a tag space. When the persona
    // specifies aum_band or stage_focus hints, we require that the
    // fund carries the corresponding tag-role (e.g. 'aum:$1B-$5B' or
    // 'stage:seed'). This way the hints actually narrow the candidate
    // set rather than just decorating the UI.
    const aum = readHint(persona, "aum_band");           // e.g. "$1B-$5B"
    const stages = splitCsv(readHint(persona, "stage_focus")); // e.g. ["seed","series_a"]
    const binds: unknown[] = [];
    let sql = `SELECT DISTINCT e.id FROM u_entities e
       JOIN entity_roles r ON r.entity_id = e.id
      WHERE e.status = 'active'
        AND e.kind IN ('fund','firm')
        AND r.role = 'investor_firm'`;
    if (aum) {
      sql += ` AND EXISTS (SELECT 1 FROM entity_roles ra WHERE ra.entity_id = e.id AND ra.role = ?)`;
      binds.push(`aum:${aum}`);
    }
    if (stages.length) {
      const ph = stages.map(() => "?").join(",");
      sql += ` AND EXISTS (SELECT 1 FROM entity_roles rs WHERE rs.entity_id = e.id AND rs.role IN (${ph}))`;
      binds.push(...stages.map((s) => `stage:${s}`));
    }
    sql += ` ORDER BY e.id LIMIT ? OFFSET ?`;
    binds.push(limit, offset);
    return { sql, binds };
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
