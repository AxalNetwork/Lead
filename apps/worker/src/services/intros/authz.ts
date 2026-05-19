// Pure access-control helpers for the intro routes. Extracted so the
// access matrix can be unit-tested without spinning up a Hono app or
// stubbing D1.
//
// Rules (per code review):
//   - intro_paths is "owned" by intro_paths.viewer_email.
//   - Only the owner OR an admin may log outcomes against a path.
//     Unauthorized writes would poison the nightly retrain labels.
//   - by-target reads are owner-scoped: non-admin callers see only
//     their own rows AND the viewer_email column is suppressed.
//     Admins see every row with the column.

export type OutcomeAccessDecision =
  | { allowed: true; reason: "owner" | "admin" }
  | { allowed: false; reason: "not_owner" | "no_caller" };

/** Decide whether `callerEmail` may write an outcome to a path
 *  whose original requester was `ownerEmail`. Comparison is
 *  case-insensitive. Admin always wins. */
export function decideOutcomeAccess(
  callerEmail: string | null | undefined,
  ownerEmail: string | null | undefined,
  isAdmin: boolean,
): OutcomeAccessDecision {
  if (isAdmin) return { allowed: true, reason: "admin" };
  if (!callerEmail) return { allowed: false, reason: "no_caller" };
  const caller = callerEmail.toLowerCase();
  const owner = (ownerEmail ?? "").toLowerCase();
  if (caller && caller === owner) return { allowed: true, reason: "owner" };
  return { allowed: false, reason: "not_owner" };
}

/** Decide the read scope for /by-target/:id. */
export function decideByTargetScope(
  callerEmail: string | null | undefined,
  isAdmin: boolean,
): { scope: "admin" | "owner"; project_viewer_email: boolean; filter_owner_email: string | null } {
  if (isAdmin) return { scope: "admin", project_viewer_email: true, filter_owner_email: null };
  // Non-admin: project a reduced column set AND filter to caller's
  // own rows. When caller has no email (anonymous), return empty
  // owner scope (filter_owner_email = "" never matches).
  return {
    scope: "owner",
    project_viewer_email: false,
    filter_owner_email: callerEmail ?? null,
  };
}
