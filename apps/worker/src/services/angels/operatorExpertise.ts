// Task #4: Operator-angel domain-expertise derivation.
//
// Reads day-job firm's sector tags + role title and emits a small set
// of domain tags (e.g. "fintech", "payments", "infra", "dev_tools").
// Each tag is labelled with its derivation source so the API payload
// can render the citation trail.

import type { Env } from "../../types";
import type { DomainExpertiseTag } from "./types";

const ROLE_TAG_HINTS: Array<{ re: RegExp; tag: string }> = [
  { re: /\b(payment|paytech)/i,         tag: "payments" },
  { re: /\b(security|infosec|cyber)/i,  tag: "security" },
  { re: /\b(infra|platform|sre|devops)/i, tag: "infra" },
  { re: /\b(developer|dev[\s-]tools|api)/i, tag: "dev_tools" },
  { re: /\b(growth|marketing|gtm)/i,    tag: "growth" },
  { re: /\b(data|ml|ai\b)/i,            tag: "ai_ml" },
  { re: /\b(product)/i,                 tag: "product" },
  { re: /\b(design)/i,                  tag: "design" },
  { re: /\b(finance|cfo)/i,             tag: "finance" },
  { re: /\b(sales|revenue|cro)/i,       tag: "sales" },
];

const SECTOR_NORMALIZE: Array<{ re: RegExp; tag: string }> = [
  { re: /\b(fintech|financial[\s-]technology|payments)\b/i, tag: "fintech" },
  { re: /\b(payments?)\b/i,             tag: "payments" },
  { re: /\b(saas|software)\b/i,         tag: "saas" },
  { re: /\b(ai|artificial[\s-]intelligence|machine[\s-]learning|ml)\b/i, tag: "ai_ml" },
  { re: /\b(security|cyber|infosec)\b/i, tag: "security" },
  { re: /\b(developer[\s-]tools|dev[\s-]tools|api[\s-]platform)\b/i, tag: "dev_tools" },
  { re: /\b(infra|infrastructure|cloud|platform)\b/i, tag: "infra" },
  { re: /\b(commerce|e[\s-]?commerce|retail)\b/i, tag: "commerce" },
  { re: /\b(health|biotech|medtech)\b/i, tag: "health" },
  { re: /\b(crypto|web3|blockchain)\b/i, tag: "crypto" },
  { re: /\b(marketplace)\b/i,            tag: "marketplace" },
  { re: /\b(consumer|d2c)\b/i,           tag: "consumer" },
  { re: /\b(media|content|video)\b/i,    tag: "media" },
];

function uniqTags(tags: DomainExpertiseTag[]): DomainExpertiseTag[] {
  const seen = new Map<string, DomainExpertiseTag>();
  for (const t of tags) {
    if (!seen.has(t.tag)) seen.set(t.tag, t);
  }
  return [...seen.values()];
}

/** Pull sector / industry tags from the firm's fact graph. */
async function loadFirmSectors(env: Env, firmEntityId: string): Promise<string[]> {
  const res = await env.DB.prepare(
    `SELECT predicate, value_text, value_json
       FROM facts
      WHERE entity_id = ?
        AND predicate IN ('sector','industry','firm.sector','firm.industry','firm.sectors','sectors')
        AND is_current = 1
      LIMIT 50`,
  ).bind(firmEntityId).all<{ predicate: string; value_text: string | null; value_json: string | null }>();
  const out: string[] = [];
  for (const r of res.results ?? []) {
    if (r.value_text) out.push(r.value_text);
    if (r.value_json) {
      try {
        const j = JSON.parse(r.value_json);
        if (Array.isArray(j)) for (const x of j) if (typeof x === "string") out.push(x);
      } catch { /* ignore */ }
    }
  }
  return out;
}

export async function deriveDomainExpertise(
  env: Env,
  args: { dayJobEntityId: string | null; dayJobRole: string | null; investmentSectors: string[] },
): Promise<DomainExpertiseTag[]> {
  const tags: DomainExpertiseTag[] = [];

  if (args.dayJobEntityId) {
    const sectors = await loadFirmSectors(env, args.dayJobEntityId);
    for (const s of sectors) {
      for (const m of SECTOR_NORMALIZE) {
        if (m.re.test(s)) tags.push({ tag: m.tag, source: "day_job_firm" });
      }
    }
  }

  if (args.dayJobRole) {
    for (const h of ROLE_TAG_HINTS) {
      if (h.re.test(args.dayJobRole)) tags.push({ tag: h.tag, source: "role" });
    }
  }

  // Investment pattern: any sector that appears in >=3 disclosed investments.
  const counts = new Map<string, number>();
  for (const s of args.investmentSectors) {
    for (const m of SECTOR_NORMALIZE) {
      if (m.re.test(s)) counts.set(m.tag, (counts.get(m.tag) ?? 0) + 1);
    }
  }
  for (const [tag, n] of counts) {
    if (n >= 3) tags.push({ tag, source: "investment_pattern" });
  }

  return uniqTags(tags);
}
