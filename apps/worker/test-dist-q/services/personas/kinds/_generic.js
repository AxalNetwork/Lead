// Task #3: Generic kind plugin used as the default for kinds that
// don't ship a bespoke matcher. Drives candidate selection from the
// taxonomy's `targets` (entity kind) + `roles` (entity_roles.role IN)
// and delegates scoring to the existing PersonaMatchingService scorer
// for person targets. Company/fund targets currently fall back to the
// legacy persona_matches/accounts/buyers code path via the dispatcher.
import { loadPersonEntity, scoreEntityForPersona as scorePersonForPersona } from "../../personaMatching";
import { KINDS } from "./taxonomy";
export function makeGenericPlugin(kind) {
    const def = KINDS[kind];
    return {
        kind,
        defaultEntityFilter(_persona, opts) {
            const limit = Math.max(1, Math.min(opts?.limit ?? 100, 500));
            const offset = Math.max(0, opts?.offset ?? 0);
            const binds = [def.targets];
            let sql = `SELECT DISTINCT e.id FROM u_entities e`;
            if (def.roles.length) {
                sql += ` JOIN entity_roles r ON r.entity_id = e.id`;
            }
            sql += ` WHERE e.kind = ? AND e.status = 'active'`;
            if (def.roles.length) {
                sql += ` AND r.role IN (${def.roles.map(() => "?").join(",")})`;
                binds.push(...def.roles);
            }
            sql += ` ORDER BY e.id LIMIT ? OFFSET ?`;
            binds.push(limit, offset);
            return { sql, binds };
        },
        async scoreEntity(env, persona, entityId) {
            // Default behavior: only person targets are scored via the
            // graph scorer. Fund/company targets are out of scope for the
            // person-graph matcher and return null so the caller skips them.
            if (def.targets !== "person")
                return null;
            const entity = await loadPersonEntity(env, entityId);
            if (!entity)
                return null;
            return await scorePersonForPersona(env, persona, entity);
        },
        explainMatch(entityId) {
            return `kind=${kind} target=${def.targets}${def.roles.length ? " roles=" + def.roles.join("|") : ""} entity=${entityId}`;
        },
    };
}
