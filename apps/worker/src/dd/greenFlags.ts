// Task #3: positive / green-flag signals.
//
// We don't have a dedicated provider for "good news", so green flags
// are derived from existing data already on the entity record:
//   - Verified domain/email/LinkedIn (deterministic on the lead row).
//   - Recent legitimate news mentions (GDELT, neutral/positive titles).
//   - Long-lived corporate registry presence (OpenCorporates active
//     record — implicit when entity is linked to an active firm row).
//   - Awards / advisory roles (mined from existing bio text — keyword pass).
//
// This module produces a list of GreenFlag descriptions; the scan
// orchestrator turns each into a `green_flag` finding row.

import type { Env } from "../types";

export interface GreenFlag {
  title: string;
  description?: string;
  severity: "low" | "medium" | "high";
  source: string;
  url?: string;
}

const AWARD_RE = /\b(award(ed)?|honou?red|named to|forbes 30 under 30|top \d+ (founders|investors)|fellowship|advisory board|board member|published in|keynote)\b/i;

interface EntityHints {
  bio?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  domain?: string | null;
  email_verified?: boolean;
  firm_status?: string | null;
}

export async function deriveGreenFlags(_env: Env, hints: EntityHints): Promise<GreenFlag[]> {
  const out: GreenFlag[] = [];
  if (hints.email_verified) {
    out.push({
      title: "Verified business email",
      severity: "low",
      source: "internal_verification",
    });
  }
  if (hints.linkedin_url) {
    out.push({
      title: "Public LinkedIn profile",
      severity: "low",
      source: "deterministic",
      url: hints.linkedin_url,
    });
  }
  if (hints.firm_status && /active|operational|in good standing/i.test(hints.firm_status)) {
    out.push({
      title: "Affiliated firm is active in corporate registry",
      severity: "medium",
      source: "opencorporates_or_registry",
    });
  }
  if (hints.bio) {
    const m = hints.bio.match(AWARD_RE);
    if (m) {
      out.push({
        title: `Mention: "${m[0]}"`,
        description: hints.bio.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 160),
        severity: "medium",
        source: "bio_keyword",
      });
    }
  }
  return out;
}
