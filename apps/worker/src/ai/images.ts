// Cloudflare Images binding helper (Task #25 step 9).
//
// On every scraped avatar_url / logo_url: fetch via IMAGES.upload, store
// the returned image id in leads.avatar_id / firms.logo_id /
// companies.logo_id, and serve via the named variants. The variants
// (face-100 / card-300 / hero-800) are configured account-side in the
// Cloudflare Images dashboard; this helper just constructs the URL.

import type { Env } from "../types";

const ACCOUNT_HASH_VAR = "CF_IMAGES_ACCOUNT_HASH";

export type ImageVariant = "face-100" | "card-300" | "hero-800";

export function imageUrl(env: Env & { CF_IMAGES_ACCOUNT_HASH?: string }, id: string | null | undefined, variant: ImageVariant): string | null {
  if (!id) return null;
  const hash = env.CF_IMAGES_ACCOUNT_HASH ?? (env as unknown as Record<string, unknown>)[ACCOUNT_HASH_VAR] as string | undefined;
  if (!hash) return null;
  return `https://imagedelivery.net/${hash}/${id}/${variant}`;
}

export async function uploadAndPersist(
  env: Env,
  sourceUrl: string,
  kind: "lead" | "firm" | "company",
  id: string | number,
): Promise<string | null> {
  if (!env.IMAGES || !sourceUrl) return null;
  try {
    const res = await env.IMAGES.upload({ url: sourceUrl, metadata: { kind, ref: String(id) } });
    if (!res?.id) return null;
    const col = kind === "lead" ? "avatar_id" : "logo_id";
    const table = kind === "lead" ? "leads" : kind === "firm" ? "firms" : "companies";
    await env.DB.prepare(`UPDATE ${table} SET ${col} = ? WHERE id = ?`).bind(res.id, id).run();
    return res.id;
  } catch (e) {
    console.warn("uploadAndPersist failed", kind, (e as Error).message);
    return null;
  }
}
