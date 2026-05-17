// Task #2: URL canonicalization for the discovery layer.
//
// Cheap, deterministic, no network. Normalizes the URL so that the
// `url_canonical` UNIQUE index does what we want: prevent re-discovering
// the same page under trivial query-string / casing / fragment variants.

export interface CanonicalUrl {
  url: string;          // original (preserved for display)
  canonical: string;    // normalized key for UNIQUE index
  host: string;         // bare hostname, lowercased, www-stripped
  scheme: "http" | "https" | "other";
}

const TRACKING_PARAMS = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_name", "fbclid", "gclid", "dclid", "msclkid", "yclid",
  "mc_cid", "mc_eid", "ref", "ref_src", "ref_url", "_hsenc", "_hsmi",
  "hsCtaTracking", "vero_conv", "vero_id", "wickedid", "igshid",
]);

export function canonicalizeUrl(input: string): CanonicalUrl | null {
  if (!input) return null;
  let raw = input.trim();
  if (!raw) return null;
  // Reject obvious non-http schemes — mailto/tel/javascript should never
  // enter the frontier. We do allow them past canonicalize so the caller
  // can decide; mark scheme=other.
  if (/^(mailto:|tel:|javascript:|sms:|fax:)/i.test(raw)) {
    return { url: raw, canonical: raw.toLowerCase(), host: "", scheme: "other" };
  }
  // Add a scheme if missing so URL() doesn't throw on bare hostnames.
  if (!/^https?:\/\//i.test(raw)) raw = "https://" + raw.replace(/^\/+/, "");
  let u: URL;
  try { u = new URL(raw); } catch { return null; }

  const scheme = u.protocol === "https:" ? "https" : (u.protocol === "http:" ? "http" : "other");
  // Lowercase host, strip leading www.
  let host = u.hostname.toLowerCase();
  if (host.startsWith("www.")) host = host.slice(4);
  // Strip default ports.
  let port = u.port;
  if ((scheme === "http" && port === "80") || (scheme === "https" && port === "443")) port = "";
  // Strip fragment.
  // Normalize path: collapse `//` and drop trailing slash unless root.
  let path = u.pathname || "/";
  path = path.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  // Filter out tracking params, sort the rest for stable order.
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.has(k.toLowerCase()))
    .map(([k, v]) => [k.toLowerCase(), v] as [string, string])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const qs = params.length ? "?" + params.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&") : "";

  const canonical = `${scheme}://${host}${port ? ":" + port : ""}${path}${qs}`;
  // Re-render the original URL with fragments stripped + normalized host
  // for display so we don't leak utm_ params into the UI.
  const display = `${scheme}://${u.hostname}${port ? ":" + port : ""}${path}${qs}`;
  return { url: display, canonical, host, scheme };
}

export function sameSite(aHost: string, bHost: string): boolean {
  if (!aHost || !bHost) return false;
  if (aHost === bHost) return true;
  // Match second-level domain (a.example.com ↔ b.example.com).
  const a = aHost.split(".").slice(-2).join(".");
  const b = bHost.split(".").slice(-2).join(".");
  return a === b;
}

// Trivial rejects we never want in the frontier regardless of yield.
const SOCIAL_SHARE_HOST_RE = /^(twitter|x|facebook|linkedin|reddit|pinterest|t)\.(com|me|co)$/i;
const SOCIAL_SHARE_PATH_RE = /\/(intent|share|sharer|share-offsite|submit)\b/i;
const ASSET_EXT_RE = /\.(png|jpe?g|gif|webp|svg|ico|css|js|woff2?|ttf|otf|eot|map)(?:\?|$)/i;

export function isObviousReject(c: CanonicalUrl): string | null {
  if (c.scheme === "other") return "non_http_scheme";
  if (SOCIAL_SHARE_HOST_RE.test(c.host) && SOCIAL_SHARE_PATH_RE.test(c.canonical)) return "social_share_intent";
  if (ASSET_EXT_RE.test(c.canonical)) return "static_asset";
  // Bare domains with nothing useful (e.g. cdn.example.com).
  if (/^(cdn|static|assets|img|images|s3|storage|files?)\./.test(c.host)) return "cdn_asset_host";
  return null;
}
