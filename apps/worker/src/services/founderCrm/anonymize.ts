// Task #5: Anonymity scrub for founder feedback.
//
// The submitter's email is HASHED with a bound salt that includes
// the investor + raise_year so we can detect duplicate ballots
// (one founder spam-rating the same investor twice in the same year)
// WITHOUT being able to re-identify the founder from the row.
//
// Why hash and not drop entirely: we still need a uniqueness key so
// duplicate submissions don't poison the aggregate. The hash domain
// is so narrow (one investor x year per submitter) that it's not
// a useful re-identification signal — but a separate KV-side
// secret SALT makes brute-forcing the {investor, year} → email
// pre-image computationally pointless.
//
// PII columns that arrive on the request body but MUST NOT persist
// anywhere on the row are stripped here: submitter_email,
// submitter_name, company_name, deal_id.

export interface RawFeedbackInput {
  investor_entity_id?: string;
  raise_year?: number | string | null;
  raise_outcome?: string | null;
  terms_summary?: string | null;
  behavior_rating?: number | string | null;
  speed_to_no_days?: number | string | null;
  free_text?: string | null;
  // PII fields — must be stripped before persist
  submitter_email?: string;
  submitter_name?: string | null;
  company_name?: string | null;
  deal_id?: string | null;
}

export interface AnonymizedFeedback {
  investor_entity_id: string;
  raise_year: number | null;
  raise_outcome: string | null;
  terms_summary: string | null;
  behavior_rating: number | null;
  speed_to_no_days: number | null;
  free_text: string | null;
  submitter_hash: string;   // sha256 hex
}

const VALID_OUTCOMES = new Set(["closed", "passed", "ghosted", "reneged"]);

/** Coerce a value to int, clamped to [min,max], or null. */
function toInt(v: unknown, min: number, max: number): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  if (i < min || i > max) return null;
  return i;
}

/** Strip identifying metadata from raw free-text input. Removes
 *  emails, urls, and runs whitespace through a single squashed pass.
 *  Truncated to 2000 chars so a single review can't carry hidden
 *  re-identification payloads. */
export function scrubText(s: string | null | undefined, maxLen = 2000): string | null {
  if (!s) return null;
  let t = String(s);
  t = t.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[email]");
  t = t.replace(/https?:\/\/\S+/g, "[url]");
  t = t.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.slice(0, maxLen);
}

/** Build the sha256 submitter_hash. Pure: callers pass the salt so
 *  this module never has to reach into env. */
export async function hashSubmitter(
  submitterEmail: string,
  investorEntityId: string,
  raiseYear: number | null,
  salt: string,
): Promise<string> {
  const email = submitterEmail.trim().toLowerCase();
  const input = `${salt}|${email}|${investorEntityId}|${raiseYear ?? ""}`;
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Validate + anonymize a raw founder feedback submission.
 *  Returns null when the row is unusable (no investor, no submitter
 *  email, or rating outside 1..5). Callers that get null should
 *  return 400 to the client. */
export async function anonymizeFeedback(
  input: RawFeedbackInput,
  salt: string,
): Promise<AnonymizedFeedback | null> {
  const investor = (input.investor_entity_id ?? "").trim();
  const email = (input.submitter_email ?? "").trim();
  if (!investor || !email) return null;
  const rating = toInt(input.behavior_rating, 1, 5);
  if (rating == null) return null;

  const year = toInt(input.raise_year, 1990, 9999);
  const outcomeRaw = (input.raise_outcome ?? "").toString().trim().toLowerCase();
  const outcome = VALID_OUTCOMES.has(outcomeRaw) ? outcomeRaw : null;

  return {
    investor_entity_id: investor,
    raise_year: year,
    raise_outcome: outcome,
    terms_summary: scrubText(input.terms_summary ?? null, 400),
    behavior_rating: rating,
    speed_to_no_days: toInt(input.speed_to_no_days, 0, 3650),
    free_text: scrubText(input.free_text ?? null, 2000),
    submitter_hash: await hashSubmitter(email, investor, year, salt),
  };
}
