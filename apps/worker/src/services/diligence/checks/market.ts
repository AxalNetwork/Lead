// Task #6: Market-section checks.

import type { CheckDefinition } from "../types";
import { needsHuman, passResult, failResult, cautionResult, readCurrentFact, safeQuery } from "../_util";

export const MARKET_CHECKS: CheckDefinition[] = [
  {
    key: "market.tam_sam_som_sanity",
    section: "market",
    title: "TAM/SAM/SOM sanity (SAM ≤ TAM, SOM ≤ SAM)",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const tam = await readCurrentFact(env, target_entity_id, "market.tam_usd");
      const sam = await readCurrentFact(env, target_entity_id, "market.sam_usd");
      const som = await readCurrentFact(env, target_entity_id, "market.som_usd");
      if (!tam || !sam || !som) return needsHuman(this.title, "missing_market_size_facts", "medium");
      const t = tam.value_number ?? 0, s = sam.value_number ?? 0, o = som.value_number ?? 0;
      if (o > s || s > t) return failResult(this.title, `Ordering invalid: SOM=${o} SAM=${s} TAM=${t}.`, "medium");
      if (s > 0.5 * t) return cautionResult(this.title, `SAM is >50% of TAM (${(s / t * 100).toFixed(0)}%) — review market definition.`, "medium");
      return passResult(this.title, "TAM ≥ SAM ≥ SOM and ratios within typical bounds.");
    },
  },
  {
    key: "market.competitor_landscape",
    section: "market",
    title: "Competitor landscape recorded",
    severity: "low",
    async run({ env, target_entity_id }) {
      const q = await safeQuery(
        () => env.DB.prepare(
          `SELECT COUNT(*) AS n FROM rel_edges
            WHERE rel_kind = 'competitor_of' AND (a_entity_id = ? OR b_entity_id = ?)`,
        ).bind(target_entity_id, target_entity_id).first<{ n: number }>(),
        "rel_edges_missing",
      );
      if (!q.ok) return needsHuman(this.title, q.reason, "low");
      const n = q.value?.n ?? 0;
      if (n >= 3) return passResult(this.title, `${n} competitors mapped.`);
      if (n >= 1) return cautionResult(this.title, `Only ${n} competitor(s) mapped.`, "low");
      return failResult(this.title, "No competitors mapped yet.", "low");
    },
  },
  {
    key: "market.growth_corroboration",
    section: "market",
    title: "Market growth corroboration (third-party signal)",
    severity: "low",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "market.growth_rate_pct");
      if (!f) return needsHuman(this.title, "no_growth_rate_fact", "low");
      const g = f.value_number ?? 0;
      if (g >= 10 && g <= 80) return passResult(this.title, `Recorded growth rate ${g}% — within plausible range.`, f.evidence_url ? [f.evidence_url] : []);
      if (g < 0) return failResult(this.title, `Negative growth rate ${g}%.`, "medium", f.evidence_url ? [f.evidence_url] : []);
      return cautionResult(this.title, `Recorded growth rate ${g}% — outside typical bounds, corroborate.`, "low");
    },
  },
];
