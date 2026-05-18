// Task #2: LP-disclosure adapter registry. Aggregates the per-LP
// adapters into a single array that the main adapter registry spreads
// into ADAPTERS.

import type { SiteAdapter } from "../types";
import { calpers } from "./calpers";
import { US_PENSION_ADAPTERS } from "./usPensions";
import { ENDOWMENT_ANNUAL_ADAPTERS } from "./endowmentAnnual";
import { endowment990 } from "./endowment990";
import { SOVEREIGN_ADAPTERS } from "./sovereign";

export const LP_DISCLOSURE_ADAPTERS: SiteAdapter[] = [
  calpers,
  ...US_PENSION_ADAPTERS,
  ...ENDOWMENT_ANNUAL_ADAPTERS,
  endowment990,
  ...SOVEREIGN_ADAPTERS,
];

export type { LpDisclosurePayload, LpCommitmentCandidate, LpClass } from "./types";
