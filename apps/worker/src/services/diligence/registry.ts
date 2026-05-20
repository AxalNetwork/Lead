// Task #6: typed registry of every diligence check.
//
// Each check is a (target_entity_id, ctx) → CheckResult function. Checks
// register themselves into REGISTRY at module load. The runner dispatches
// by check_key in the order the chosen template lists them. Unknown
// check_keys in a template are skipped with a needs_human result so the
// run never silently drops a requested check.

import type { CheckDefinition } from "./types";
import { CORPORATE_CHECKS } from "./checks/corporate";
import { FOUNDER_CHECKS } from "./checks/founders";
import { MARKET_CHECKS } from "./checks/market";
import { PRODUCT_CHECKS } from "./checks/product";
import { TRACTION_CHECKS } from "./checks/traction";
import { TEAM_CHECKS } from "./checks/team";
import { REGULATORY_CHECKS } from "./checks/regulatory";
import { FINANCIAL_CHECKS } from "./checks/financial";
import { IP_CHECKS } from "./checks/ip";

const ALL: CheckDefinition[] = [
  ...CORPORATE_CHECKS,
  ...FOUNDER_CHECKS,
  ...MARKET_CHECKS,
  ...PRODUCT_CHECKS,
  ...TRACTION_CHECKS,
  ...TEAM_CHECKS,
  ...REGULATORY_CHECKS,
  ...FINANCIAL_CHECKS,
  ...IP_CHECKS,
];

export const REGISTRY: Map<string, CheckDefinition> = new Map(
  ALL.map((c) => [c.key, c]),
);

export function listChecks(): CheckDefinition[] {
  return [...REGISTRY.values()];
}

export function getCheck(key: string): CheckDefinition | undefined {
  return REGISTRY.get(key);
}

// Ordered list of check_keys for the default 50-point template,
// covering the 9 spec sections.
export const DEFAULT_TEMPLATE_KEYS: string[] = ALL.map((c) => c.key);
