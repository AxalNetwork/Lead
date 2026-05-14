import type { MiddlewareHandler } from "hono";
import type { Env } from "../types";

interface JwksKey {
  kid: string;
  kty: string;
  alg?: string;
  use?: string;
  n: string;
  e: string;
}

let jwksCache: { keys: JwksKey[]; fetchedAt: number } | null = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function getJwks(teamDomain: string): Promise<JwksKey[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error("jwks_fetch_failed");
  const data = (await res.json()) as { keys: JwksKey[] };
  jwksCache = { keys: data.keys, fetchedAt: now };
  return data.keys;
}

function base64UrlDecode(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = (input + pad).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifyJwt(token: string, jwks: JwksKey[], expectedAud: string, expectedIss: string): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed_jwt");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(headerB64))) as { kid?: string; alg?: string };
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadB64))) as Record<string, unknown>;
  const key = jwks.find((k) => k.kid === header.kid);
  if (!key) throw new Error("kid_not_found");
  const cryptoKey = await crypto.subtle.importKey(
    "jwk",
    { kty: key.kty, n: key.n, e: key.e, alg: key.alg ?? "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, base64UrlDecode(sigB64), data);
  if (!ok) throw new Error("bad_signature");
  const aud = payload.aud;
  const audOk = Array.isArray(aud) ? aud.includes(expectedAud) : aud === expectedAud;
  if (!audOk) throw new Error("bad_aud");
  if (typeof payload.iss === "string" && payload.iss !== expectedIss) throw new Error("bad_iss");
  const exp = typeof payload.exp === "number" ? payload.exp : 0;
  if (exp && Math.floor(Date.now() / 1000) > exp) throw new Error("expired");
  return payload;
}

export const accessGuard: MiddlewareHandler<{ Bindings: Env; Variables: { email: string } }> = async (c, next) => {
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!token) return c.json({ error: "no_access_jwt" }, 401);
  try {
    const jwks = await getJwks(c.env.ACCESS_TEAM_DOMAIN);
    const iss = `https://${c.env.ACCESS_TEAM_DOMAIN}`;
    const claims = await verifyJwt(token, jwks, c.env.ACCESS_AUD, iss);
    const email = typeof claims.email === "string" ? claims.email : "";
    if (!email) return c.json({ error: "no_email_claim" }, 401);
    if (email.toLowerCase() !== c.env.ALLOWED_EMAIL.toLowerCase()) {
      return c.json({ error: "forbidden", email }, 403);
    }
    c.set("email", email);
    await next();
  } catch (e) {
    return c.json({ error: "invalid_jwt", detail: (e as Error).message }, 401);
  }
};
