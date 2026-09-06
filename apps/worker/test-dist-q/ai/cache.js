const PREFIX = "ai-cache";
export async function sha256Hex(input) {
    const buf = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
export async function aiCacheGet(env, key) {
    if (!env.AI_CACHE)
        return null;
    try {
        const obj = await env.AI_CACHE.get(`${PREFIX}/${key}`);
        if (!obj)
            return null;
        const text = await obj.text();
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
export async function aiCachePut(env, key, value) {
    if (!env.AI_CACHE)
        return;
    try {
        await env.AI_CACHE.put(`${PREFIX}/${key}`, JSON.stringify(value), {
            httpMetadata: { contentType: "application/json" },
            customMetadata: { stored_at: new Date().toISOString() },
        });
    }
    catch {
        /* swallow — cache is best-effort */
    }
}
