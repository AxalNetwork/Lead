// Task #9: Signed envelope protocol shared by worker + runner.
//
// HMAC-SHA256 over {node_id, timestamp, nonce, body_sha256}. Both
// sides reject envelopes older than ENVELOPE_TTL_MS (60s) and reject
// reused nonces via a 60s rolling nonce-cache in KV. Constants are
// exported so the @axal/worker-runner SDK can import them verbatim
// — single source of truth.

export const ENVELOPE_TTL_MS = 60_000;
export const NONCE_CACHE_TTL_S = 70; // > TTL window so a replay landing
                                     // at t=ENVELOPE_TTL is still seen.

export interface Envelope {
  node_id: string;
  timestamp: number;     // ms since epoch
  nonce: string;
  body_sha256: string;   // hex
  signature: string;     // hex HMAC-SHA256
}

function hex(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export async function sha256Hex(bytes: Uint8Array | string): Promise<string> {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  return hex(await crypto.subtle.digest("SHA-256", data));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export function canonicalString(e: { node_id: string; timestamp: number; nonce: string; body_sha256: string }): string {
  return `${e.node_id}\n${e.timestamp}\n${e.nonce}\n${e.body_sha256}`;
}

export async function signEnvelope(
  secret: string,
  parts: { node_id: string; body: string | Uint8Array },
): Promise<Envelope> {
  const timestamp = Date.now();
  const nonce = crypto.randomUUID();
  const body_sha256 = await sha256Hex(parts.body);
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalString({ node_id: parts.node_id, timestamp, nonce, body_sha256 })),
  );
  return { node_id: parts.node_id, timestamp, nonce, body_sha256, signature: hex(sig) };
}

export type VerifyResult = { ok: true } | { ok: false; reason: string };
export async function verifyEnvelope(
  secret: string,
  env: Envelope,
  body: string | Uint8Array,
  opts?: { nowMs?: number; ttlMs?: number },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const now = opts?.nowMs ?? Date.now();
  const ttl = opts?.ttlMs ?? ENVELOPE_TTL_MS;
  if (typeof env.timestamp !== "number" || !Number.isFinite(env.timestamp)) {
    return { ok: false, reason: "bad_timestamp" };
  }
  if (Math.abs(now - env.timestamp) > ttl) return { ok: false, reason: "stale_envelope" };
  const expected = await sha256Hex(body);
  if (expected !== env.body_sha256) return { ok: false, reason: "body_hash_mismatch" };
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    hexToBytes(env.signature),
    new TextEncoder().encode(canonicalString(env)),
  );
  if (!ok) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}

function hexToBytes(s: string): Uint8Array {
  if (s.length % 2 !== 0) return new Uint8Array();
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// In-Workers nonce cache backed by SESSIONS KV (the binding the
// dispatcher already uses for registration tokens).
export interface NonceStore {
  seen(nonce: string): Promise<boolean>;
  remember(nonce: string): Promise<void>;
}
export function kvNonceStore(kv: KVNamespace, scope = "compute:nonce"): NonceStore {
  return {
    async seen(nonce) {
      const v = await kv.get(`${scope}:${nonce}`);
      return v !== null;
    },
    async remember(nonce) {
      await kv.put(`${scope}:${nonce}`, "1", { expirationTtl: NONCE_CACHE_TTL_S });
    },
  };
}
