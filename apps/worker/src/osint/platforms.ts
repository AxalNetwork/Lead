// Cross-platform OSINT taxonomy (Task #3).
//
// Fixed enum of ~60 platforms. Each row carries:
//   slug     — canonical lowercase id (matches DB enum value).
//   label    — human-readable label for the UI.
//   category — for grouping in the UI (dev/social/crypto/etc.).
//   urlOf(handle) — canonical public profile URL.
//   notFoundHints — substrings that, when present in a 200 body, mean miss.
//   handleParseRe — given a URL on this platform, extract the handle.
//
// The list is intentionally exhaustive but conservative — only platforms
// with stable, unauthenticated profile URLs and a meaningful presence on
// the public web are included.

export type PlatformSlug =
  // Code hosts
  | "github" | "gitlab" | "bitbucket" | "sourcehut" | "codeberg"
  // Q&A / dev community
  | "stackoverflow" | "hackernews" | "lobsters" | "devto" | "indiehackers"
  // Writing / blogs
  | "medium" | "substack" | "mirror" | "ghost" | "hashnode" | "wordpress"
  // Microblogs / social
  | "twitter" | "bluesky" | "mastodon" | "threads" | "warpcast" | "farcaster" | "lens"
  // Long-form social
  | "linkedin" | "facebook" | "reddit" | "quora"
  // Media
  | "instagram" | "tiktok" | "youtube" | "vimeo" | "twitch" | "soundcloud" | "spotify" | "behance" | "dribbble"
  // Books / film
  | "goodreads" | "letterboxd" | "imdb"
  // Crypto / web3
  | "ens" | "keybase" | "opensea" | "rarible" | "snapshot" | "gitcoin" | "etherscan"
  // Identity / well-known
  | "gravatar" | "about_me" | "linktree" | "carrd" | "personal_site"
  // Academia / pro
  | "orcid" | "googlescholar" | "researchgate" | "academia"
  // Other public
  | "producthunt" | "angellist" | "crunchbase" | "wikipedia"
  | "discord" | "telegram" | "matrix"
  | "stackexchange" | "kaggle" | "huggingface";

export interface PlatformDef {
  slug: PlatformSlug;
  label: string;
  category: "code" | "social" | "writing" | "media" | "crypto" | "identity" | "academia" | "other";
  urlOf: (handle: string) => string;
  notFoundHints: string[];
  // Probe via HEAD where possible; some platforms always return 200 with SPA shell.
  probeMethod: "HEAD" | "GET";
  // When set, the probe URL differs from the public profile URL (e.g. JSON API).
  probeUrlOf?: (handle: string) => string;
  handleParseRe?: RegExp;
}

const enc = encodeURIComponent;

// Helper for the most common case: https://<host>/<handle>
function simple(host: string, hints: string[] = ["page not found", "user not found", "doesn't exist", "404"]): Omit<PlatformDef, "slug" | "label" | "category"> {
  return {
    urlOf: (h) => `https://${host}/${enc(h)}`,
    notFoundHints: hints,
    probeMethod: "GET",
  };
}

export const PLATFORMS: PlatformDef[] = [
  { slug: "github",        label: "GitHub",         category: "code",      ...simple("github.com"),
    probeUrlOf: (h) => `https://api.github.com/users/${enc(h)}`, handleParseRe: /github\.com\/([A-Za-z0-9-]+)/ },
  { slug: "gitlab",        label: "GitLab",         category: "code",      ...simple("gitlab.com"),
    probeUrlOf: (h) => `https://gitlab.com/api/v4/users?username=${enc(h)}`, handleParseRe: /gitlab\.com\/([A-Za-z0-9_.-]+)/ },
  { slug: "bitbucket",     label: "Bitbucket",      category: "code",      ...simple("bitbucket.org") },
  { slug: "sourcehut",     label: "SourceHut",      category: "code",      urlOf: (h) => `https://sr.ht/~${enc(h)}/`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "codeberg",      label: "Codeberg",       category: "code",      ...simple("codeberg.org") },

  { slug: "stackoverflow", label: "Stack Overflow", category: "code",      urlOf: (h) => `https://stackoverflow.com/users/${enc(h)}`, notFoundHints: ["Page Not Found"], probeMethod: "GET" },
  { slug: "hackernews",    label: "Hacker News",    category: "writing",   urlOf: (h) => `https://news.ycombinator.com/user?id=${enc(h)}`, notFoundHints: ["No such user"], probeMethod: "GET",
    probeUrlOf: (h) => `https://hacker-news.firebaseio.com/v0/user/${enc(h)}.json` },
  { slug: "lobsters",      label: "Lobsters",       category: "writing",   urlOf: (h) => `https://lobste.rs/u/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "devto",         label: "DEV",            category: "writing",   ...simple("dev.to"), probeUrlOf: (h) => `https://dev.to/api/users/by_username?url=${enc(h)}` },
  { slug: "indiehackers",  label: "Indie Hackers",  category: "writing",   urlOf: (h) => `https://www.indiehackers.com/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },

  { slug: "medium",        label: "Medium",         category: "writing",   urlOf: (h) => `https://medium.com/@${enc(h)}`, notFoundHints: ["PAGE NOT FOUND", "doesn’t exist"], probeMethod: "GET" },
  { slug: "substack",      label: "Substack",       category: "writing",   urlOf: (h) => `https://${enc(h)}.substack.com`, notFoundHints: ["This Substack doesn’t exist"], probeMethod: "GET" },
  { slug: "mirror",        label: "Mirror",         category: "writing",   urlOf: (h) => `https://mirror.xyz/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "ghost",         label: "Ghost",          category: "writing",   urlOf: (h) => `https://${enc(h)}.ghost.io`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "hashnode",      label: "Hashnode",       category: "writing",   urlOf: (h) => `https://hashnode.com/@${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "wordpress",     label: "WordPress.com",  category: "writing",   urlOf: (h) => `https://${enc(h)}.wordpress.com`, notFoundHints: ["doesn’t exist"], probeMethod: "GET" },

  { slug: "twitter",       label: "X / Twitter",    category: "social",    urlOf: (h) => `https://x.com/${enc(h)}`, notFoundHints: ["This account doesn’t exist"], probeMethod: "GET",
    handleParseRe: /(?:x|twitter)\.com\/(?!status|i\/)([A-Za-z0-9_]+)/ },
  { slug: "bluesky",       label: "Bluesky",        category: "social",    urlOf: (h) => `https://bsky.app/profile/${enc(h)}`, notFoundHints: ["Profile not found", "404"], probeMethod: "GET" },
  { slug: "mastodon",      label: "Mastodon",       category: "social",    urlOf: (h) => `https://mastodon.social/@${enc(h)}`, notFoundHints: ["The page you are looking for isn’t here"], probeMethod: "GET" },
  { slug: "threads",       label: "Threads",        category: "social",    urlOf: (h) => `https://www.threads.net/@${enc(h)}`, notFoundHints: ["Sorry, this page isn"], probeMethod: "GET" },
  { slug: "warpcast",      label: "Warpcast",       category: "crypto",    urlOf: (h) => `https://warpcast.com/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "farcaster",     label: "Farcaster",      category: "crypto",    urlOf: (h) => `https://warpcast.com/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET",
    probeUrlOf: (h) => `https://api.warpcast.com/v2/user-by-username?username=${enc(h)}` },
  { slug: "lens",          label: "Lens",           category: "crypto",    urlOf: (h) => `https://hey.xyz/u/${enc(h)}`, notFoundHints: ["404", "Not Found"], probeMethod: "GET" },

  { slug: "linkedin",      label: "LinkedIn",       category: "social",    urlOf: (h) => `https://www.linkedin.com/in/${enc(h)}`, notFoundHints: ["Page not found"], probeMethod: "GET",
    handleParseRe: /linkedin\.com\/in\/([A-Za-z0-9-]+)/ },
  { slug: "facebook",      label: "Facebook",       category: "social",    ...simple("facebook.com") },
  { slug: "reddit",        label: "Reddit",         category: "social",    urlOf: (h) => `https://www.reddit.com/user/${enc(h)}`, notFoundHints: ["Sorry, nobody on Reddit goes by that name"], probeMethod: "GET",
    probeUrlOf: (h) => `https://www.reddit.com/user/${enc(h)}/about.json` },
  { slug: "quora",         label: "Quora",          category: "social",    urlOf: (h) => `https://www.quora.com/profile/${enc(h)}`, notFoundHints: ["This page isn’t available"], probeMethod: "GET" },

  { slug: "instagram",     label: "Instagram",      category: "media",     ...simple("instagram.com", ["Sorry, this page isn't available"]) },
  { slug: "tiktok",        label: "TikTok",         category: "media",     urlOf: (h) => `https://www.tiktok.com/@${enc(h)}`, notFoundHints: ["Couldn't find this account"], probeMethod: "GET" },
  { slug: "youtube",       label: "YouTube",        category: "media",     urlOf: (h) => `https://www.youtube.com/@${enc(h)}`, notFoundHints: ["404 Not Found"], probeMethod: "GET" },
  { slug: "vimeo",         label: "Vimeo",          category: "media",     ...simple("vimeo.com") },
  { slug: "twitch",        label: "Twitch",         category: "media",     ...simple("twitch.tv") },
  { slug: "soundcloud",    label: "SoundCloud",     category: "media",     ...simple("soundcloud.com") },
  { slug: "spotify",       label: "Spotify",        category: "media",     urlOf: (h) => `https://open.spotify.com/user/${enc(h)}`, notFoundHints: ["Page not found"], probeMethod: "GET" },
  { slug: "behance",       label: "Behance",        category: "media",     urlOf: (h) => `https://www.behance.net/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "dribbble",      label: "Dribbble",       category: "media",     ...simple("dribbble.com") },

  { slug: "goodreads",     label: "Goodreads",      category: "media",     urlOf: (h) => `https://www.goodreads.com/user/show/${enc(h)}`, notFoundHints: ["Page not found"], probeMethod: "GET" },
  { slug: "letterboxd",    label: "Letterboxd",     category: "media",     ...simple("letterboxd.com") },
  { slug: "imdb",          label: "IMDb",           category: "media",     urlOf: (h) => `https://www.imdb.com/user/${enc(h)}`, notFoundHints: ["Page not found"], probeMethod: "GET" },

  { slug: "ens",           label: "ENS",            category: "crypto",    urlOf: (h) => `https://app.ens.domains/${enc(h)}`, notFoundHints: ["not registered"], probeMethod: "GET" },
  { slug: "keybase",       label: "Keybase",        category: "identity",  urlOf: (h) => `https://keybase.io/${enc(h)}`, notFoundHints: ["User not found", "404"], probeMethod: "GET",
    probeUrlOf: (h) => `https://keybase.io/_/api/1.0/user/lookup.json?usernames=${enc(h)}` },
  { slug: "opensea",       label: "OpenSea",        category: "crypto",    urlOf: (h) => `https://opensea.io/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "rarible",       label: "Rarible",        category: "crypto",    urlOf: (h) => `https://rarible.com/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "snapshot",      label: "Snapshot",       category: "crypto",    urlOf: (h) => `https://snapshot.org/#/profile/${enc(h)}`, notFoundHints: [], probeMethod: "GET" },
  { slug: "gitcoin",       label: "Gitcoin",        category: "crypto",    urlOf: (h) => `https://gitcoin.co/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "etherscan",     label: "Etherscan",      category: "crypto",    urlOf: (h) => `https://etherscan.io/address/${enc(h)}`, notFoundHints: [], probeMethod: "GET" },

  { slug: "gravatar",      label: "Gravatar",       category: "identity",  urlOf: (h) => `https://gravatar.com/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET",
    probeUrlOf: (h) => `https://gravatar.com/${enc(h)}.json` },
  { slug: "about_me",      label: "About.me",       category: "identity",  ...simple("about.me") },
  { slug: "linktree",      label: "Linktree",       category: "identity",  ...simple("linktr.ee") },
  { slug: "carrd",         label: "Carrd",          category: "identity",  urlOf: (h) => `https://${enc(h)}.carrd.co`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "personal_site", label: "Personal site",  category: "identity",  urlOf: (h) => h.startsWith("http") ? h : `https://${h}`, notFoundHints: [], probeMethod: "GET" },

  { slug: "orcid",         label: "ORCID",          category: "academia",  urlOf: (h) => `https://orcid.org/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "googlescholar", label: "Google Scholar", category: "academia",  urlOf: (h) => `https://scholar.google.com/citations?user=${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "researchgate",  label: "ResearchGate",   category: "academia",  urlOf: (h) => `https://www.researchgate.net/profile/${enc(h)}`, notFoundHints: ["Page not found"], probeMethod: "GET" },
  { slug: "academia",      label: "Academia.edu",   category: "academia",  urlOf: (h) => `https://independent.academia.edu/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },

  { slug: "producthunt",   label: "Product Hunt",   category: "other",     urlOf: (h) => `https://www.producthunt.com/@${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "angellist",     label: "AngelList",      category: "other",     urlOf: (h) => `https://angel.co/u/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "crunchbase",    label: "Crunchbase",     category: "other",     urlOf: (h) => `https://www.crunchbase.com/person/${enc(h)}`, notFoundHints: ["Page not found"], probeMethod: "GET" },
  { slug: "wikipedia",     label: "Wikipedia",      category: "other",     urlOf: (h) => `https://en.wikipedia.org/wiki/${enc(h)}`, notFoundHints: ["does not have an article"], probeMethod: "GET" },

  { slug: "discord",       label: "Discord",        category: "social",    urlOf: (h) => `https://discord.com/users/${enc(h)}`, notFoundHints: [], probeMethod: "GET" },
  { slug: "telegram",      label: "Telegram",       category: "social",    urlOf: (h) => `https://t.me/${enc(h)}`, notFoundHints: [], probeMethod: "GET" },
  { slug: "matrix",        label: "Matrix",         category: "social",    urlOf: (h) => `https://matrix.to/#/@${enc(h)}`, notFoundHints: [], probeMethod: "GET" },

  { slug: "stackexchange", label: "Stack Exchange", category: "code",      urlOf: (h) => `https://stackexchange.com/users/${enc(h)}`, notFoundHints: ["Page Not Found"], probeMethod: "GET" },
  { slug: "kaggle",        label: "Kaggle",         category: "academia",  urlOf: (h) => `https://www.kaggle.com/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
  { slug: "huggingface",   label: "Hugging Face",   category: "academia",  urlOf: (h) => `https://huggingface.co/${enc(h)}`, notFoundHints: ["404"], probeMethod: "GET" },
];

export const PLATFORM_COUNT = PLATFORMS.length;

const BY_SLUG = new Map<string, PlatformDef>(PLATFORMS.map((p) => [p.slug, p]));
export function getPlatform(slug: string): PlatformDef | null {
  return BY_SLUG.get(slug) ?? null;
}

// Try to parse a (platform, handle) from an arbitrary URL.
export function parseProfileUrl(url: string): { platform: PlatformSlug; handle: string } | null {
  if (!url) return null;
  for (const p of PLATFORMS) {
    if (!p.handleParseRe) continue;
    const m = url.match(p.handleParseRe);
    if (m && m[1]) return { platform: p.slug, handle: m[1] };
  }
  return null;
}
