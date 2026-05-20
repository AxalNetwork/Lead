// Task #9: Registration flow.
//
// Admin pastes a name/provider/kind into /ops/compute-nodes and gets a
// short-lived registration token (10-minute TTL in KV). The runner
// exchanges the token for the long-lived HMAC secret. The secret is
// minted in KV at `auth_secret_kv_key` and returned ONCE in the
// response body — never re-readable. D1 stores only the KV path.

import type { Env } from "../../types";

const REG_TOKEN_PREFIX = "compute:reg:";
const REG_TOKEN_TTL_S = 10 * 60;
const SECRET_KV_PREFIX = "compute:secret:";

export interface PendingRegistration {
  name: string;
  provider: string;
  kind: "cpu" | "gpu" | "browser";
  supported_job_types: string[];
  max_concurrent_jobs: number;
  cost_per_hour_usd: number;
  cost_per_1k_tokens_usd: number;
  capabilities_json: Record<string, unknown>;
  registered_by: string;
  created_at: number;
}

function randomBase64Url(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function shortId(prefix: string): string {
  return `${prefix}${randomBase64Url(9)}`;
}

export async function mintRegistrationToken(
  env: Env,
  reg: Omit<PendingRegistration, "created_at">,
): Promise<{ token: string; expires_at: string }> {
  const token = randomBase64Url(24);
  const payload: PendingRegistration = { ...reg, created_at: Date.now() };
  await env.SESSIONS.put(REG_TOKEN_PREFIX + token, JSON.stringify(payload), {
    expirationTtl: REG_TOKEN_TTL_S,
  });
  return {
    token,
    expires_at: new Date(Date.now() + REG_TOKEN_TTL_S * 1000).toISOString(),
  };
}

export async function readRegistrationToken(env: Env, token: string): Promise<PendingRegistration | null> {
  const raw = await env.SESSIONS.get(REG_TOKEN_PREFIX + token);
  if (!raw) return null;
  try { return JSON.parse(raw) as PendingRegistration; } catch { return null; }
}

export async function consumeRegistrationToken(env: Env, token: string): Promise<PendingRegistration | null> {
  const v = await readRegistrationToken(env, token);
  if (!v) return null;
  await env.SESSIONS.delete(REG_TOKEN_PREFIX + token);
  return v;
}

/** Mint per-node HMAC secret in KV and return the KV path. Secret is
 *  high-entropy random; returned ONCE here and never re-readable from
 *  D1 (D1 only stores the path). */
export async function mintNodeSecret(env: Env, nodeId: string): Promise<{ secret: string; kvKey: string }> {
  const secret = randomBase64Url(32);
  const kvKey = SECRET_KV_PREFIX + nodeId;
  // No TTL — the secret lives as long as the node does. Rotation
  // re-mints via the same code path with a new value.
  await env.SESSIONS.put(kvKey, secret);
  return { secret, kvKey };
}

export async function readNodeSecret(env: Env, kvKey: string): Promise<string | null> {
  return env.SESSIONS.get(kvKey);
}

export async function deleteNodeSecret(env: Env, kvKey: string): Promise<void> {
  await env.SESSIONS.delete(kvKey);
}
