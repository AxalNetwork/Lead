// Task #4 (Relationship Inference Worker): canonical edge writer.
//
// Upserts EdgeProposal[] against the existing uq_rel_edges_quad unique
// index (src_entity_id, dst_entity_id, kind, IFNULL(valid_from, '')).
// On conflict we bump `evidence_count`, refresh `last_evidence_at`, and
// append to `backing_fact_ids_json` rather than inserting a duplicate.
//
// Per the Task #3 edge-quality contract, `quality_score` is set ONLY on
// the first insert from `baselineQuality(kind, source)`. Subsequent
// observations NEVER overwrite the score — the Task #3 nightly sweep
// is the authority on refined values.
import { baselineQuality } from "./baselines";
function mergeBackingIds(existingJson, incoming) {
    const set = new Set();
    if (existingJson) {
        try {
            const arr = JSON.parse(existingJson);
            if (Array.isArray(arr))
                for (const id of arr)
                    if (typeof id === "string")
                        set.add(id);
        }
        catch { /* malformed json — drop and rebuild from incoming */ }
    }
    for (const id of incoming ?? [])
        if (typeof id === "string" && id)
            set.add(id);
    return JSON.stringify(Array.from(set));
}
export async function persistEdges(env, proposals) {
    const res = { inserted: 0, merged: 0, errors: 0, error_messages: [] };
    for (const p of proposals) {
        if (!p.src_entity_id || !p.dst_entity_id || p.src_entity_id === p.dst_entity_id)
            continue;
        try {
            // Look up existing edge on the unique-index columns. IFNULL on
            // valid_from matches the unique index definition.
            const existing = await env.DB.prepare(`SELECT id, backing_fact_ids_json, evidence_count
           FROM rel_edges
          WHERE src_entity_id = ? AND dst_entity_id = ? AND kind = ?
            AND IFNULL(valid_from, '') = IFNULL(?, '')
          LIMIT 1`).bind(p.src_entity_id, p.dst_entity_id, p.kind, p.valid_from ?? null).first();
            const now = new Date().toISOString();
            if (existing) {
                const merged = mergeBackingIds(existing.backing_fact_ids_json, p.backing_fact_ids);
                await env.DB.prepare(`UPDATE rel_edges
              SET evidence_count = COALESCE(evidence_count, 1) + 1,
                  last_evidence_at = ?,
                  backing_fact_ids_json = ?
            WHERE id = ?`).bind(now, merged, existing.id).run();
                res.merged += 1;
            }
            else {
                const id = crypto.randomUUID();
                const baseline = baselineQuality(p.kind, p.source);
                const backing = JSON.stringify(p.backing_fact_ids ?? []);
                await env.DB.prepare(`INSERT INTO rel_edges (
             id, src_entity_id, dst_entity_id, kind, strength,
             valid_from, valid_to, evidence_url, backing_fact_ids_json,
             source, created_at, quality_score, evidence_count, last_evidence_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`).bind(id, p.src_entity_id, p.dst_entity_id, p.kind, baseline, p.valid_from ?? null, p.valid_to ?? null, p.evidence_url ?? null, backing, p.source, now, baseline, now).run();
                res.inserted += 1;
            }
        }
        catch (e) {
            // The unique index can race two concurrent inserts; retry-as-merge
            // is safe because we look up first. Other errors are reported.
            const msg = e.message || "unknown";
            if (/UNIQUE/i.test(msg)) {
                try {
                    const again = await env.DB.prepare(`SELECT id, backing_fact_ids_json, evidence_count FROM rel_edges
              WHERE src_entity_id = ? AND dst_entity_id = ? AND kind = ?
                AND IFNULL(valid_from, '') = IFNULL(?, '') LIMIT 1`).bind(p.src_entity_id, p.dst_entity_id, p.kind, p.valid_from ?? null).first();
                    if (again) {
                        const merged = mergeBackingIds(again.backing_fact_ids_json, p.backing_fact_ids);
                        await env.DB.prepare(`UPDATE rel_edges
                  SET evidence_count = COALESCE(evidence_count, 1) + 1,
                      last_evidence_at = ?, backing_fact_ids_json = ?
                WHERE id = ?`).bind(new Date().toISOString(), merged, again.id).run();
                        res.merged += 1;
                        continue;
                    }
                }
                catch { /* fall through to error */ }
            }
            res.errors += 1;
            if (res.error_messages.length < 5)
                res.error_messages.push(msg);
        }
    }
    return res;
}
