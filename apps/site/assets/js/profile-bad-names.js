// Task #4 (and Task #5 backfill consumer): single source of truth for
// "this entity name looks like a type/category, not a real name".
//
// Sibling module: apps/worker/src/entities/badName.ts — keep in sync.
// Exposed via window.ADS.BadName so any dashboard page (firm-detail,
// investor-detail, profile) can decide on the displayed name without
// duplicating the predicate.

(function () {
  if (window.ADS && window.ADS.BadName) return;
  window.ADS = window.ADS || {};

  var BAD_NAME_LITERALS = new Set([
    "vc", "pe", "lp", "gp", "llc", "inc", "co", "corp", "ltd", "plc",
    "firm", "fund", "company", "organization", "org", "nonprofit",
    "non-profit", "training program", "training",
    "accelerator", "incubator", "investor", "angel", "angel group",
    "family office", "corp vc", "gov fund",
  ]);
  var BAD_NAME_LIST_RE = /^[a-z][a-z\s/&-]{1,40}(?:,\s*[a-z][a-z\s/&-]{1,40})+$/i;

  function isBadEntityName(name) {
    if (!name) return true;
    var trimmed = String(name).trim();
    if (trimmed.length < 3) return true;
    var lower = trimmed.toLowerCase();
    if (BAD_NAME_LITERALS.has(lower)) return true;
    if (BAD_NAME_LIST_RE.test(trimmed)) return true;
    return false;
  }

  function displayFromDomain(input) {
    if (!input) return null;
    var host;
    try {
      host = new URL(String(input).indexOf("://") >= 0 ? input : "https://" + input).hostname;
    } catch (_) {
      host = String(input);
    }
    host = host.replace(/^www\./i, "").trim();
    if (!host) return null;
    var parts = host.split(".");
    var stem = parts.length > 1 ? parts.slice(0, -1).join(".") : host;
    if (!stem) return null;
    return stem.split(/[-_.]+/).filter(Boolean).map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    }).join(" ");
  }

  window.ADS.BadName = { isBadEntityName: isBadEntityName, displayFromDomain: displayFromDomain };
})();
