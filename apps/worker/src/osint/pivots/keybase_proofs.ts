// Keybase proofs pivot — uses the public lookup API to fetch cryptographically
// verified social proofs (twitter, github, reddit, hackernews, web, etc.).
// Hits from Keybase are the highest-confidence link method we have because
// each proof is signed by the user's key.

import type { Env } from "../../types";
import type { KnownEntityFacts, PivotContext, PivotHit } from "../types";
import { simpleGet, pastDeadline } from "./_util";
import type { PlatformSlug } from "../platforms";

const PROOF_TO_PLATFORM: Record<string, PlatformSlug> = {
  twitter: "twitter",
  github: "github",
  reddit: "reddit",
  hackernews: "hackernews",
  facebook: "facebook",
  generic_web_site: "personal_site",
};

interface KbProof { proof_type: string; nametag: string; service_url?: string; presentation_url?: string; state?: number }
interface KbUser { basics: { username: string }; proofs_summary?: { all?: KbProof[] } }

export async function runKeybaseProofs(_env: Env, facts: KnownEntityFacts, ctx: PivotContext): Promise<PivotHit[]> {
  if (pastDeadline(ctx.deadlineMs)) return [];
  const out: PivotHit[] = [];

  // Resolve a Keybase username: either we already know one (link_method='keybase'
  // already present in facts) or we try the candidates extracted from emails /
  // known handles.
  const seeds = new Set<string>();
  for (const kh of facts.knownHandles) {
    if (kh.platform === "keybase") seeds.add(kh.handle);
    if (kh.platform === "github" || kh.platform === "twitter") seeds.add(kh.handle);
  }
  for (const e of facts.emails) {
    const local = e.split("@")[0];
    if (local && /^[a-z0-9_]+$/.test(local)) seeds.add(local);
  }
  if (!seeds.size) return [];

  const usernames = [...seeds].slice(0, 5).join(",");
  const res = await simpleGet(`https://keybase.io/_/api/1.0/user/lookup.json?usernames=${encodeURIComponent(usernames)}&fields=basics,proofs_summary`, { timeoutMs: 4000, accept: "application/json" });
  if (!res.ok) return [];
  let body: { them?: Array<KbUser | null> };
  try { body = JSON.parse(res.text); } catch { return []; }
  for (const them of body.them ?? []) {
    if (!them || !them.basics) continue;
    const kbUser = them.basics.username;
    out.push({
      platform: "keybase",
      handle: kbUser,
      url: `https://keybase.io/${kbUser}`,
      link_method: "keybase",
      base_confidence: 0.98,
      evidence_json: { kind: "keybase_user", username: kbUser },
    });
    for (const pf of them.proofs_summary?.all ?? []) {
      const plat = PROOF_TO_PLATFORM[pf.proof_type];
      if (!plat || !pf.nametag) continue;
      // state===1 means active+verified per Keybase API.
      const confidence = pf.state === 1 ? 0.98 : 0.85;
      out.push({
        platform: plat,
        handle: pf.nametag,
        url: pf.service_url ?? pf.presentation_url ?? null as unknown as string,
        link_method: "keybase",
        base_confidence: confidence,
        evidence_json: { kind: "keybase_proof", keybase_user: kbUser, proof_type: pf.proof_type, state: pf.state },
      });
    }
  }
  return out;
}
