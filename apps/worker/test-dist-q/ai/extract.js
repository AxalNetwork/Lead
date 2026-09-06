// AI-powered extraction (Task #25 step 2).
//
// Strategy: deterministic strategies in `firmcrawl/personExtract.ts` run
// first (cheap). Misses get routed through Workers AI with a strict JSON
// schema response, chunked at ~6KB. Every call is cached by
// sha256(model+prompt+chunk) in the AI_CACHE R2 bucket (30-day TTL via
// bucket lifecycle policy). Verification pass drops <0.6 confidence.
//
// Hooked into pipeline.ts firm_team_crawl path opportunistically: if `AI`
// binding is present and deterministic strategies returned <3 people on a
// non-trivial page, we run the AI pass and union by nameKey.
import { aiCacheGet, aiCachePut, sha256Hex } from "./cache";
import { assertBudget } from "./budget";
import { limitAi } from "../scraper/rateLimit";
import { trackAi } from "../analytics/events";
// Task #2: hard timeout for Workers AI calls. The binding does not accept
// AbortSignal, so we race against a timer and surface a uniform
// "ai_timeout" error.
//
// POLICY: one canonical 30s ceiling for any single AI call (constant
// `AI_TIMEOUT_MS` below). This is well below the 90s default job
// budget, so even three serial AI calls fit inside a single job's
// wall-clock ceiling. Short-form purposes (embeddings, arbitration)
// use `AI_TIMEOUT_SHORT_MS` (20s) since they're trivially smaller.
//
// NB: this is a *caller-side* timeout — it bounds how long the worker
// will wait on the Workers AI binding, but it does NOT cancel the
// underlying model execution. The binding doesn't expose an
// AbortSignal as of this revision, so model inference may continue
// (and bill) for a short tail after we move on. Acceptable today
// because the queue-level budget + sweeper will reclaim the job; if
// the binding gains cancellation, swap the race for a real abort.
const AI_TIMEOUT_MS = 30_000;
const AI_TIMEOUT_SHORT_MS = 20_000;
async function runAiWithTimeout(p, ms, label) {
    let timer = null;
    try {
        return await Promise.race([
            p,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`ai_timeout:${label}:${ms}ms`)), ms);
            }),
        ]);
    }
    finally {
        if (timer)
            clearTimeout(timer);
    }
}
const PERSON_SCHEMA = {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: { type: "string" },
                    role: { type: "string" },
                    email: { type: "string" },
                    linkedin: { type: "string" },
                    twitter: { type: "string" },
                    bio: { type: "string" },
                    confidence: { type: "number" },
                },
                required: ["name", "confidence"],
            },
        },
    },
    required: ["people"],
};
const CHUNK_BYTES = 6000;
const MIN_CONFIDENCE = 0.6;
function chunk(text, size) {
    const out = [];
    for (let i = 0; i < text.length; i += size)
        out.push(text.slice(i, i + size));
    return out;
}
function stripHtml(html) {
    return html
        .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}
export async function aiExtractPeople(env, html, jobId) {
    if (!env.AI)
        return [];
    const ok = await assertBudget(env, "ai");
    if (!ok.ok)
        return [];
    if (!(await limitAi(env)))
        return [];
    const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
    const text = stripHtml(html);
    const chunks = chunk(text, CHUNK_BYTES).slice(0, 4); // hard ceiling per page
    const all = [];
    for (const c of chunks) {
        const cacheKey = await sha256Hex(`${model}:people:${c}`);
        const cached = await aiCacheGet(env, cacheKey);
        if (cached) {
            trackAi(env, { purpose: "extraction", model, cacheHit: true, jobId });
            all.push(...cached);
            continue;
        }
        const t0 = Date.now();
        let people = [];
        try {
            const res = (await runAiWithTimeout(env.AI.run(model, {
                messages: [
                    { role: "system", content: "Extract investors/partners as JSON. Skip non-people. Return strict JSON." },
                    { role: "user", content: `Extract people from this team-page text. ${c}` },
                ],
                response_format: { type: "json_schema", json_schema: PERSON_SCHEMA },
            }), AI_TIMEOUT_MS, "extract_people"));
            const parsed = parsePeopleResponse(res);
            people = parsed.filter((p) => (p.confidence ?? 0) >= MIN_CONFIDENCE);
        }
        catch (e) {
            console.warn("aiExtractPeople failed", e.message);
        }
        trackAi(env, { purpose: "extraction", model, ms: Date.now() - t0, neurons: estimateNeurons(c.length), jobId });
        await aiCachePut(env, cacheKey, people);
        all.push(...people);
    }
    return dedupePeopleByName(all);
}
function parsePeopleResponse(res) {
    const r = res;
    if (Array.isArray(r?.people))
        return r.people.filter((p) => p && typeof p.name === "string");
    if (typeof r?.response === "string") {
        try {
            const j = JSON.parse(r.response);
            if (Array.isArray(j?.people))
                return j.people.filter((p) => p && typeof p.name === "string");
        }
        catch { /* fall through */ }
    }
    return [];
}
function dedupePeopleByName(arr) {
    const map = new Map();
    for (const p of arr) {
        const key = p.name.trim().toLowerCase();
        if (!key)
            continue;
        const cur = map.get(key);
        if (!cur || (p.confidence ?? 0) > (cur.confidence ?? 0))
            map.set(key, p);
    }
    return [...map.values()];
}
// Rough neurons estimate: tokens ≈ chars/4, llama-3.1-8b ~ 0.011 neurons/token.
function estimateNeurons(chars) {
    const tokens = Math.ceil(chars / 4);
    return Math.round(tokens * 0.011 * 1000) / 1000;
}
const TABLE_SCHEMA = {
    type: "object",
    properties: {
        tables: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    headers: { type: "array", items: { type: "string" } },
                    rows: { type: "array", items: { type: "array", items: { type: "string" } } },
                },
                required: ["headers", "rows"],
            },
        },
    },
    required: ["tables"],
};
const TABLE_PAGE_CHAR_CAP = 8000;
const MAX_AI_PAGES = 12;
export async function aiExtractTablesFromPdfPages(env, pageTexts) {
    if (!env.AI || !pageTexts.length)
        return [];
    const ok = await assertBudget(env, "ai");
    if (!ok.ok)
        return [];
    const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
    const out = [];
    let lastHeaderKey = null;
    const pages = pageTexts.slice(0, MAX_AI_PAGES);
    for (let p = 0; p < pages.length; p++) {
        const raw = pages[p].trim();
        if (raw.length < 40)
            continue;
        const text = raw.length > TABLE_PAGE_CHAR_CAP ? raw.slice(0, TABLE_PAGE_CHAR_CAP) : raw;
        const cacheKey = await sha256Hex(`${model}:pdf-tables:${text}`);
        let pageTables = await aiCacheGet(env, cacheKey);
        if (pageTables) {
            trackAi(env, { purpose: "extraction", model, cacheHit: true });
        }
        else {
            if (!(await limitAi(env)))
                continue;
            const t0 = Date.now();
            try {
                const res = (await runAiWithTimeout(env.AI.run(model, {
                    messages: [
                        { role: "system", content: "You extract tabular data from a single PDF page. Return strict JSON {tables: [{headers, rows}]}. Skip page numbers, app chrome (File/Edit/View toolbars, sheet tab strips, Share buttons), and prose paragraphs. If the page has no table, return {tables: []}. Each row must have the same length as headers; pad with empty strings if needed." },
                        { role: "user", content: `PDF page text:\n${text}` },
                    ],
                    response_format: { type: "json_schema", json_schema: TABLE_SCHEMA },
                }), AI_TIMEOUT_MS, "extract_tables"));
                pageTables = parseTablesResponse(res);
            }
            catch (e) {
                console.warn("aiExtractTablesFromPdfPages failed", e.message);
                pageTables = [];
            }
            trackAi(env, { purpose: "extraction", model, ms: Date.now() - t0, neurons: estimateNeurons(text.length) });
            await aiCachePut(env, cacheKey, pageTables);
        }
        for (const t of pageTables) {
            if (!Array.isArray(t.headers) || t.headers.length < 2)
                continue;
            if (!Array.isArray(t.rows) || t.rows.length < 1)
                continue;
            const headers = t.headers.map((h) => String(h || "").trim());
            const headerKey = headers.join("|").toLowerCase();
            const rows = t.rows.map((r) => {
                const obj = {};
                for (let c = 0; c < headers.length; c++)
                    obj[headers[c] || `col_${c}`] = String(r?.[c] ?? "").trim();
                return obj;
            }).filter((r) => Object.values(r).some((v) => v.length > 0));
            if (!rows.length)
                continue;
            if (lastHeaderKey === headerKey && out.length) {
                out[out.length - 1].rows.push(...rows);
            }
            else {
                out.push({ headers, rows, pageNumber: p + 1, confidence: 0.5 });
                lastHeaderKey = headerKey;
            }
        }
    }
    return out;
}
function parseTablesResponse(res) {
    const r = res;
    if (Array.isArray(r?.tables))
        return r.tables;
    if (typeof r?.response === "string") {
        try {
            const j = JSON.parse(r.response);
            if (Array.isArray(j?.tables))
                return j.tables;
        }
        catch { /* fall through */ }
    }
    return [];
}
export async function aiEmbed(env, text) {
    if (!env.AI)
        return null;
    const model = env.AI_EMBED_MODEL ?? "@cf/baai/bge-base-en-v1.5";
    const cacheKey = await sha256Hex(`${model}:embed:${text}`);
    const cached = await aiCacheGet(env, cacheKey);
    if (cached) {
        trackAi(env, { purpose: "embedding", model, cacheHit: true });
        return cached;
    }
    const ok = await assertBudget(env, "ai");
    if (!ok.ok)
        return null;
    if (!(await limitAi(env)))
        return null;
    const t0 = Date.now();
    try {
        const res = (await runAiWithTimeout(env.AI.run(model, { text: [text] }), AI_TIMEOUT_SHORT_MS, "embed"));
        const vec = Array.isArray(res?.data?.[0]) ? res.data[0] : null;
        if (!vec)
            return null;
        trackAi(env, { purpose: "embedding", model, ms: Date.now() - t0, neurons: estimateNeurons(text.length) });
        await aiCachePut(env, cacheKey, vec);
        return vec;
    }
    catch (e) {
        console.warn("aiEmbed failed", e.message);
        return null;
    }
}
export async function aiArbitrate(env, candidateA, candidateB) {
    if (!env.AI)
        return { match: "maybe", confidence: 0 };
    const model = env.AI_EXTRACT_MODEL ?? "@cf/meta/llama-3.1-8b-instruct-fast";
    const cacheKey = await sha256Hex(`${model}:arb:${candidateA}|${candidateB}`);
    const cached = await aiCacheGet(env, cacheKey);
    if (cached) {
        trackAi(env, { purpose: "arbitration", model, cacheHit: true });
        return cached;
    }
    const ok = await assertBudget(env, "ai");
    if (!ok.ok)
        return { match: "maybe", confidence: 0 };
    if (!(await limitAi(env)))
        return { match: "maybe", confidence: 0 };
    const t0 = Date.now();
    try {
        const res = (await runAiWithTimeout(env.AI.run(model, {
            messages: [
                { role: "system", content: "Decide if two profiles describe the same person. Reply JSON: {match: yes|no|maybe, confidence: 0..1}." },
                { role: "user", content: `A: ${candidateA}\nB: ${candidateB}` },
            ],
            response_format: { type: "json_object" },
        }), AI_TIMEOUT_SHORT_MS, "arbitrate"));
        const out = parseArbResponse(res);
        trackAi(env, { purpose: "arbitration", model, ms: Date.now() - t0, neurons: estimateNeurons(candidateA.length + candidateB.length) });
        await aiCachePut(env, cacheKey, out);
        return out;
    }
    catch (e) {
        console.warn("aiArbitrate failed", e.message);
        return { match: "maybe", confidence: 0 };
    }
}
function parseArbResponse(res) {
    if (typeof res?.response === "string") {
        try {
            const j = JSON.parse(res.response);
            const match = j.match === "yes" || j.match === "no" ? j.match : "maybe";
            return { match, confidence: Math.max(0, Math.min(1, Number(j.confidence ?? 0))) };
        }
        catch { /* fall through */ }
    }
    return { match: "maybe", confidence: 0 };
}
