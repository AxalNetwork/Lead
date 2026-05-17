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

async function verifyJwt(token: string, jwks: JwksKey[], allowedAuds: string[], expectedIss: string): Promise<Record<string, unknown>> {
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
  const audValues = Array.isArray(aud) ? aud : typeof aud === "string" ? [aud] : [];
  const audOk = audValues.some((a) => allowedAuds.includes(String(a)));
  if (!audOk) throw new Error("bad_aud");
  if (typeof payload.iss !== "string" || payload.iss !== expectedIss) throw new Error("bad_iss");
  if (typeof payload.exp !== "number") throw new Error("missing_exp");
  const now = Math.floor(Date.now() / 1000);
  if (now > payload.exp) throw new Error("expired");
  if (typeof payload.nbf === "number" && now + 30 < payload.nbf) throw new Error("not_yet_valid");
  return payload;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("Cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export const accessGuard: MiddlewareHandler<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }> = async (c, next) => {
  const token =
    c.req.header("Cf-Access-Jwt-Assertion") ||
    readCookie(c.req.raw, "CF_Authorization");
  if (!token) return c.json({ error: "no_access_jwt" }, 401);
  try {
    const jwks = await getJwks(c.env.ACCESS_TEAM_DOMAIN);
    const iss = `https://${c.env.ACCESS_TEAM_DOMAIN}`;
    const allowedAuds = [c.env.ACCESS_AUD, c.env.ACCESS_APP_AUD].filter(Boolean) as string[];
    const claims = await verifyJwt(token, jwks, allowedAuds, iss);
    const email = typeof claims.email === "string" ? claims.email : "";
    if (!email) return c.json({ error: "no_email_claim" }, 401);
    if (email.toLowerCase() !== c.env.ALLOWED_EMAIL.toLowerCase()) {
      return c.json({ error: "forbidden", email }, 403);
    }
    c.set("email", email);
    c.set("is_admin", false);
    await next();
  } catch (e) {
    console.warn("Access JWT verification failed:", (e as Error).message);
    return c.json({ error: "unauthorized" }, 401);
  }
};

export const adminOnly: MiddlewareHandler<{ Bindings: Env; Variables: { email: string; is_admin: boolean } }> = async (c, next) => {
  const isAdmin = c.var.is_admin === true || c.req.header("X-Admin") === "true";
  if (!isAdmin) return c.json({ error: "forbidden" }, 403);
  c.set("is_admin", true);
  await next();
};
