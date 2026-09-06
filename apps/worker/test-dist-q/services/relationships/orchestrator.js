// Task #4: orchestrator. Runs every extractor (full pass when
// opts.entityId/since are null; incremental otherwise), persists
// proposals via persistEdges, returns a structured summary.
import { persistEdges } from "./persist";
import { clearResolveCache } from "./resolve";
import * as worksAtFromTitle from "./extractors/worksAtFromTitle";
import * as investedInFromDeals from "./extractors/investedInFromDeals";
import * as boardSeatFromFilings from "./extractors/boardSeatFromFilings";
import * as coInvestorFromDeals from "./extractors/coInvestorFromDeals";
import * as employmentHistoryFromLinkedIn from "./extractors/employmentHistoryFromLinkedIn";
import * as educationFromBio from "./extractors/educationFromBio";
import * as familyFromPublicSources from "./extractors/familyFromPublicSources";
import * as colleagueOverlap from "./extractors/colleagueOverlap";
import * as schoolWith from "./extractors/schoolWith";
import * as coAuthorFromPublications from "./extractors/coAuthorFromPublications";
import * as mentionFromNews from "./extractors/mentionFromNews";
import * as portfolioFromFirmSite from "./extractors/portfolioFromFirmSite";
import * as advisorFromBio from "./extractors/advisorFromBio";
const EXTRACTORS = [
    worksAtFromTitle, investedInFromDeals, boardSeatFromFilings, coInvestorFromDeals,
    employmentHistoryFromLinkedIn, educationFromBio, familyFromPublicSources,
    colleagueOverlap, schoolWith, coAuthorFromPublications, mentionFromNews,
    portfolioFromFirmSite, advisorFromBio,
];
export function listExtractors() { return EXTRACTORS.map((x) => x.NAME); }
function emptyRun() {
    return { proposed: 0, inserted: 0, merged: 0, unresolved: 0, scanned: 0, errors: 0, error_messages: [] };
}
export async function runAllExtractors(env, opts = {}) {
    const t0 = Date.now();
    clearResolveCache();
    const summary = { by_extractor: {}, total_edges: 0, duration_ms: 0 };
    for (const ex of EXTRACTORS) {
        const run = emptyRun();
        try {
            const res = await ex.extract(env, opts);
            run.proposed = res.proposals.length;
            run.unresolved = res.unresolved_count;
            run.scanned = res.scanned;
            if (res.proposals.length) {
                const p = await persistEdges(env, res.proposals);
                run.inserted = p.inserted;
                run.merged = p.merged;
                run.errors = p.errors;
                run.error_messages = p.error_messages;
            }
        }
        catch (e) {
            run.errors += 1;
            run.error_messages.push(e.message || "extractor threw");
            console.warn("relationships extractor failed", ex.NAME, e.message);
        }
        summary.by_extractor[ex.NAME] = run;
        summary.total_edges += run.inserted + run.merged;
    }
    summary.duration_ms = Date.now() - t0;
    return summary;
}
/**
 * Drain the relationship_infer_queue staging table (added by migration
 * 377) — one orchestrator pass per queued entity, bounded by `limit`.
 * Called from the consolidated nightly slot in scheduled.ts.
 */
export async function drainInferQueue(env, limit = 200) {
    let drained = 0, total_edges = 0;
    try {
        const r = await env.DB.prepare(`SELECT entity_id FROM relationship_infer_queue ORDER BY queued_at ASC LIMIT ?`).bind(limit).all();
        const ids = (r.results ?? []).map((row) => row.entity_id);
        for (const id of ids) {
            try {
                const s = await runAllExtractors(env, { entityId: id });
                total_edges += s.total_edges;
            }
            catch (e) {
                console.warn("drainInferQueue per-entity failed", id, e.message);
            }
            try {
                await env.DB.prepare(`DELETE FROM relationship_infer_queue WHERE entity_id = ?`).bind(id).run();
            }
            catch { /* swallow */ }
            drained += 1;
        }
    }
    catch (e) {
        const msg = e.message || "";
        if (!/no such table/i.test(msg))
            console.warn("drainInferQueue failed", msg);
    }
    return { drained, total_edges };
}
/**
 * Debounced enqueue called from createEntity / insertFact. KV-debounce
 * (1 minute window) collapses a burst of writes for the same entity
 * into a single queued row.
 */
export async function enqueueRelInfer(env, entityId, reason) {
    if (!entityId)
        return;
    try {
        if (env.SESSIONS) {
            const k = `rel:infer:${entityId}`;
            const seen = await env.SESSIONS.get(k);
            if (seen)
                return;
            await env.SESSIONS.put(k, "1", { expirationTtl: 60 });
        }
        await env.DB.prepare(`INSERT INTO relationship_infer_queue (entity_id, queued_at, reason)
        VALUES (?, datetime('now'), ?)
       ON CONFLICT(entity_id) DO UPDATE SET queued_at = excluded.queued_at`).bind(entityId, reason).run();
    }
    catch (e) {
        const msg = e.message || "";
        if (!/no such table/i.test(msg))
            console.warn("enqueueRelInfer failed", msg);
    }
}
