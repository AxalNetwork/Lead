// Task #4 (Relationship Inference Worker): per-(edge_kind, source)
// baseline quality_score table. Single source of truth — extractors
// MUST look up their baseline here and never hardcode a number.
//
// Baselines are written ONLY on first insert of an edge; the Task #3
// nightly edge-quality sweep is the authority on subsequent updates,
// so we never overwrite a refined quality_score with a baseline.
// Per (kind, source) — source is the extractor/origin tag we stamp on
// the edge (e.g. "sec.form4", "press", "linkedin"). The "*" fallback
// is used when an extractor emits an edge of `kind` without a more
// specific source mapping.
const TABLE = {
    invested_in: { "sec": 0.95, "sec.form_d": 0.95, "press": 0.7, "*": 0.8 },
    board_member_at: { "sec.form4": 0.95, "sec.8k": 0.9, "sec.adv": 0.85, "*": 0.85 },
    works_at: { "title": 0.85, "*": 0.85 },
    worked_at: { "linkedin": 0.8, "*": 0.8 },
    studied_at: { "bio": 0.7, "linkedin": 0.7, "*": 0.7 },
    co_invested_with: { "deal": 0.9, "*": 0.9 },
    colleague_of: { "overlap": 0.7, "*": 0.7 },
    school_with: { "overlap": 0.55, "*": 0.55 },
    co_authored_with: { "publication": 0.75, "*": 0.75 },
    publicly_mentioned_with: { "news": 0.4, "*": 0.4 },
    portfolio_of: { "firm_site": 0.9, "*": 0.9 },
    advises: { "bio": 0.7, "*": 0.7 },
    family_of: { "wedding_notice": 0.95, "tweet": 0.6, "*": 0.6 },
};
export function baselineQuality(kind, source) {
    const row = TABLE[kind];
    if (!row)
        return 0.5;
    const src = (source ?? "").trim();
    if (src && row[src] != null)
        return row[src];
    // Try a prefix match (e.g. "sec.form4.foo" → "sec.form4").
    for (const key of Object.keys(row)) {
        if (key !== "*" && src.startsWith(key))
            return row[key];
    }
    return row["*"] ?? 0.5;
}
// Exposed for tests / introspection.
export const BASELINE_TABLE = TABLE;
