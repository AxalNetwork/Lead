// Task #45: source-module registry.
//
// Importing this module pulls every source file in alphabetical order
// (no dynamic globbing in workers). To add a new crawler: write the
// module under sources/, then append it to MODULES.

import type { Env } from "../../types";
import type { SourceModule } from "./_types";
import { isEnabled } from "./_helpers";

import greenhouse from "./greenhouse";
import lever from "./lever";
import ashby from "./ashby";
import workable from "./workable";
import recruitee from "./recruitee";
import personio from "./personio";
import smartrecruiters from "./smartrecruiters";
import hnAlgolia from "./hnAlgolia";
import ycCompanies from "./ycCompanies";
import crunchbaseNews from "./crunchbaseNews";
import secFormD from "./secFormD";
import techcrunch from "./techcrunch";
import googleNews from "./googleNews";
import productHunt from "./productHunt";
import githubOrg from "./githubOrg";
import dnsTech from "./dnsTech";
import builtwith from "./builtwith";
import wappalyzer from "./wappalyzer";
import gdelt from "./gdelt";
import g2 from "./g2";
import capterra from "./capterra";
import linkedinJobsBrave from "./linkedinJobsBrave";
import linkedinAnnounceBrave from "./linkedinAnnounceBrave";

export const MODULES: SourceModule[] = [
  greenhouse, lever, ashby, workable, recruitee, personio, smartrecruiters,
  hnAlgolia, ycCompanies, crunchbaseNews, secFormD, techcrunch, googleNews,
  productHunt, githubOrg, dnsTech, builtwith, wappalyzer, gdelt, g2, capterra,
  linkedinJobsBrave, linkedinAnnounceBrave,
];

export function getModule(slug: string): SourceModule | undefined {
  return MODULES.find((m) => m.slug === slug);
}

export async function listModulesWithState(env: Env): Promise<Array<SourceModule & { enabled: boolean; envReady: boolean }>> {
  const out: Array<SourceModule & { enabled: boolean; envReady: boolean }> = [];
  for (const m of MODULES) {
    const enabled = await isEnabled(env, m.slug, m.enabledByDefault);
    const envReady = !m.requiresEnv || Boolean((env as unknown as Record<string, unknown>)[m.requiresEnv as string]);
    out.push({ ...m, enabled, envReady });
  }
  return out;
}
