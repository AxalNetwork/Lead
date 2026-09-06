// Per-host + global AI rate limiting (Task #25 step 6).
//
// Prefers the Cloudflare Rate Limiter binding (`RL_HOST`/`RL_AI`) when
// configured. Falls back to a KV-backed leaky-bucket counter on
// SCRAPE_CACHE so the worker keeps pacing itself even when the binding is
// missing in dev or before the namespace is provisioned.
const KV_PREFIX = "rl:";
const HOST_LIMIT_PER_MIN = 60;
const AI_LIMIT_PER_MIN = 600;
const WINDOW_MS = 60_000;
async function kvLeakyBucket(kv, key, limit) {
    if (!kv)
        return true;
    const raw = await kv.get(key);
    const now = Date.now();
    let bucket = raw ? safeParse(raw) : { count: 0, window_start: now };
    if (now - bucket.window_start > WINDOW_MS)
        bucket = { count: 0, window_start: now };
    if (bucket.count >= limit)
        return false;
    bucket.count += 1;
    await kv.put(key, JSON.stringify(bucket), { expirationTtl: 120 });
    return true;
}
function safeParse(raw) {
    try {
        const v = JSON.parse(raw);
        if (typeof v?.count === "number" && typeof v?.window_start === "number")
            return v;
    }
    catch { /* swallow */ }
    return { count: 0, window_start: Date.now() };
}
export async function limitHost(env, host) {
    if (env.RL_HOST) {
        try {
            const r = await env.RL_HOST.limit({ key: host });
            return r.success;
        }
        catch { /* fall through to KV */ }
    }
    return kvLeakyBucket(env.SCRAPE_CACHE, `${KV_PREFIX}host:${host}`, HOST_LIMIT_PER_MIN);
}
export async function limitAi(env) {
    if (env.RL_AI) {
        try {
            const r = await env.RL_AI.limit({ key: "global" });
            return r.success;
        }
        catch { /* fall through */ }
    }
    return kvLeakyBucket(env.SCRAPE_CACHE, `${KV_PREFIX}ai:global`, AI_LIMIT_PER_MIN);
}
