// Mirror of apps/worker/src/services/compute/envelope.ts — runtime
// is Node here (not Workers) but the wire format and HMAC algorithm
// are identical. Single source of truth lives in the worker; this is
// a deliberate verbatim copy so the SDK has zero runtime deps.

import { createHash, createHmac, randomUUID } from "node:crypto";

export const ENVELOPE_TTL_MS = 60_000;

export interface Envelope {
  node_id: string;
  timestamp: number;
  nonce: string;
  body_sha256: string;
  signature: string;
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function canonicalString(e: { node_id: string; timestamp: number; nonce: string; body_sha256: string }): string {
  return `${e.node_id}\n${e.timestamp}\n${e.nonce}\n${e.body_sha256}`;
}

export function signEnvelope(
  secret: string,
  parts: { node_id: string; body: string | Uint8Array },
): Envelope {
  const timestamp = Date.now();
  const nonce = randomUUID();
  const body_sha256 = sha256Hex(parts.body);
  const signature = createHmac("sha256", secret)
    .update(canonicalString({ node_id: parts.node_id, timestamp, nonce, body_sha256 }))
    .digest("hex");
  return { node_id: parts.node_id, timestamp, nonce, body_sha256, signature };
}

export function verifyEnvelope(
  secret: string,
  env: Envelope,
  body: string | Uint8Array,
  opts?: { nowMs?: number; ttlMs?: number },
): { ok: true } | { ok: false; reason: string } {
  const now = opts?.nowMs ?? Date.now();
  const ttl = opts?.ttlMs ?? ENVELOPE_TTL_MS;
  if (typeof env.timestamp !== "number" || !Number.isFinite(env.timestamp)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(now - env.timestamp) > ttl) return { ok: false, reason: "stale_envelope" };
  const expected = sha256Hex(body);
  if (expected !== env.body_sha256) return { ok: false, reason: "body_hash_mismatch" };
  const sig = createHmac("sha256", secret).update(canonicalString(env)).digest("hex");
  if (sig !== env.signature) return { ok: false, reason: "bad_signature" };
  return { ok: true };
}
