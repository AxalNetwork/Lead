// Bankruptcy verifier — PACER (paid) lookup. Requires PACER_USER and
// PACER_PASS. Without those we honestly return unverifiable; we do
// NOT silently downgrade to "confirmed: no record".


import type { Verifier, VerifierResult } from "../types";

export const bankruptcyVerifier: Verifier = {
  name: "bankruptcy",
  version: "0.1.0",
  supports(c) { return c.predicate === "person.bankruptcy_check"; },
  async verify(env, _personId, claim): Promise<VerifierResult> {
    const p = claim.payload as { person_name?: string; ssn_last4?: string | null };
    const name = (p.person_name ?? "").trim();
    if (!name) return { status: "skipped", confidence: 0, reason: "missing_name" };
    const user = (env as unknown as { PACER_USER?: string }).PACER_USER;
    const pass = (env as unknown as { PACER_PASS?: string }).PACER_PASS;
    if (!user || !pass) {
      return { status: "unverifiable", confidence: 0.2, reason: "pacer_unconfigured" };
    }
    // Real PACER integration requires the PCL (PACER Case Locator)
    // SOAP/REST flow + login token rotation. Stubbed here as
    // unverifiable + reason so the contract is honest.
    return {
      status: "unverifiable",
      confidence: 0.2,
      reason: "pacer_client_not_implemented",
    };
  },
};
