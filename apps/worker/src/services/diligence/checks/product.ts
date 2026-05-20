// Task #6: Product-section checks. Reuses Task #115-style web traffic
// fact + GitHub adapter signal where present.

import type { CheckDefinition } from "../types";
import { needsHuman, passResult, failResult, cautionResult, readCurrentFact } from "../_util";

export const PRODUCT_CHECKS: CheckDefinition[] = [
  {
    key: "product.github_cadence",
    section: "product",
    title: "GitHub commit cadence (≥1 commit/week trailing 90d)",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "product.github.commits_90d");
      if (!f) return needsHuman(this.title, "no_github_commit_fact", "medium");
      const n = f.value_number ?? 0;
      if (n >= 12) return passResult(this.title, `${n} commits in trailing 90 days.`, f.evidence_url ? [f.evidence_url] : []);
      if (n >= 4) return cautionResult(this.title, `Only ${n} commits in 90 days — review engineering pace.`, "medium", f.evidence_url ? [f.evidence_url] : []);
      return failResult(this.title, `${n} commits in 90 days — repo appears dormant.`, "medium", f.evidence_url ? [f.evidence_url] : []);
    },
  },
  {
    key: "product.wayback_homepage_delta",
    section: "product",
    title: "Homepage updates (Wayback delta last 6 months)",
    severity: "low",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "product.wayback.snapshots_180d");
      if (!f) return needsHuman(this.title, "no_wayback_data", "low");
      const n = f.value_number ?? 0;
      if (n >= 4) return passResult(this.title, `${n} archived snapshots in 180 days — active site.`);
      return cautionResult(this.title, `${n} snapshots in 180 days — site appears static.`, "low");
    },
  },
  {
    key: "product.app_store_trend",
    section: "product",
    title: "App-store trend (rating + reviews)",
    severity: "low",
    async run({ env, target_entity_id }) {
      const rating = await readCurrentFact(env, target_entity_id, "product.app_store.rating");
      const reviews = await readCurrentFact(env, target_entity_id, "product.app_store.reviews_count");
      if (!rating || !reviews) return needsHuman(this.title, "no_app_store_facts", "low");
      const r = rating.value_number ?? 0;
      const rv = reviews.value_number ?? 0;
      if (r >= 4.0 && rv >= 50) return passResult(this.title, `Rating ${r.toFixed(1)} (${rv} reviews).`);
      if (r < 3.0) return failResult(this.title, `Low rating ${r.toFixed(1)} (${rv} reviews).`, "medium");
      return cautionResult(this.title, `Rating ${r.toFixed(1)} (${rv} reviews) — modest.`, "low");
    },
  },
  {
    key: "product.uptime",
    section: "product",
    title: "Uptime / status-page incidents",
    severity: "medium",
    async run({ env, target_entity_id }) {
      const f = await readCurrentFact(env, target_entity_id, "product.uptime.incidents_90d");
      if (!f) return needsHuman(this.title, "no_status_page_data", "medium");
      const n = f.value_number ?? 0;
      if (n === 0) return passResult(this.title, "No incidents reported in 90 days.");
      if (n <= 2) return cautionResult(this.title, `${n} incidents in 90 days.`, "low");
      return failResult(this.title, `${n} incidents in 90 days — reliability concern.`, "medium");
    },
  },
];
