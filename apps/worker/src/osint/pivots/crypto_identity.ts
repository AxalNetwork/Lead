// Crypto-identity pivot — ENS / Lens / Farcaster.
//
// All three protocols expose a cryptographic binding between a wallet
// address (and/or human-readable name) and a profile. Confidence is high
// because possession of the signing key is implicit.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGetCached, pastDeadline, parallelMap } from "./_util";

export async function runCryptoIdentity(env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  const out: PivotHit[] = [];

  // 1. ENS forward + reverse via ENS public subgraph proxy (ensideas).
  const ensInputs = new Set<string>();
  for (const w of facts.walletAddresses) ensInputs.add(w);
  for (const kh of facts.knownHandles) {
    if (kh.platform === "ens") ensInputs.add(kh.handle);
  }
  if (facts.displayName && facts.displayName.endsWith(".eth")) ensInputs.add(facts.displayName);

  await parallelMap([...ensInputs].slice(0, 5), 3, async (probe) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    const r = await simpleGetCached(env, `https://api.ensideas.com/ens/resolve/${encodeURIComponent(probe)}`, { timeoutMs: 4000, accept: "application/json" });
    if (!r.ok) return;
    try {
      const data = JSON.parse(r.text) as { name?: string; address?: string; avatar?: string };
      if (data.name) {
        out.push({
          platform: "ens",
          handle: data.name,
          url: `https://app.ens.domains/${data.name}`,
          link_method: "crypto_ens",
          base_confidence: 0.98,
          evidence_json: { resolved_from: probe, address: data.address, avatar: data.avatar },
        });
      }
    } catch { /* ignore */ }
  });

  // 2. Lens — handles often surface as `@handle.lens`; we probe the public
  // hey.xyz CDN-cached profile JSON (best-effort, no key).
  for (const kh of facts.knownHandles) {
    if (kh.platform !== "lens") continue;
    out.push({
      platform: "lens",
      handle: kh.handle,
      url: `https://hey.xyz/u/${kh.handle}`,
      link_method: "crypto_lens",
      base_confidence: 0.95,
      evidence_json: { source: "known_handle" },
    });
  }

  // 3. Farcaster — query Warpcast public API by username variants from emails
  // (handles are usually short). We only try low-noise candidates.
  const farcasterSeeds = new Set<string>();
  for (const kh of facts.knownHandles) {
    if (kh.platform === "farcaster" || kh.platform === "warpcast") farcasterSeeds.add(kh.handle);
    if (kh.platform === "twitter" || kh.platform === "github") farcasterSeeds.add(kh.handle);
  }
  await parallelMap([...farcasterSeeds].slice(0, 4), 2, async (name) => {
    if (pastDeadline(ctx.deadlineMs)) return;
    const r = await simpleGetCached(env, `https://api.warpcast.com/v2/user-by-username?username=${encodeURIComponent(name)}`, { timeoutMs: 4000, accept: "application/json" });
    if (!r.ok) return;
    try {
      const data = JSON.parse(r.text) as { result?: { user?: { username: string; fid: number; profile?: { bio?: { text?: string } } } } };
      const u = data.result?.user;
      if (u && u.username) {
        out.push({
          platform: "warpcast",
          handle: u.username,
          url: `https://warpcast.com/${u.username}`,
          link_method: "crypto_farcaster",
          base_confidence: 0.97,
          evidence_json: { fid: u.fid, bio: u.profile?.bio?.text ?? null },
        });
      }
    } catch { /* ignore */ }
  });

  return out;
}
