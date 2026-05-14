// Person extraction strategies for VC firm team pages. We run all eight
// strategies on the same HTML, union their hits, and dedupe by Task 8
// `nameKey` (canonicalNameFirmKey-style slug of just the person name).
//
// Strategies:
//   1. Structured-data JSON-LD `Person` entities.
//   2. OpenGraph `profile`-typed cards (og:profile:first_name etc.).
//   3. Microformats: h-card / itemtype=Person scoped containers.
//   4. Anchor cluster: 3+ LinkedIn URLs near each other (likely a roster grid).
//   5. Image-alt headshot pattern (alt="Jane Doe — Partner").
//   6. mailto: scrape with the nearest preceding heading or strong text.
//   7. Email regex against the firm domain (and obvious aliases).
//   8. JSON blob scan of `__NEXT_DATA__` / `__INITIAL_STATE__` / inline JSON.

export interface ExtractedPerson {
  name: string;
  role?: string | null;
  email?: string | null;
  linkedin?: string | null;
  twitter?: string | null;
  crunchbase?: string | null;
  personal_site?: string | null;
  avatar?: string | null;
  bio?: string | null;
  source_strategy: string;
}

const TAG_STRIP = /<[^>]+>/g;
const NAME_RE = /^[\p{Lu}][\p{L}'’.\-]+(?:\s+[\p{Lu}][\p{L}'’.\-]+){1,4}$/u;
const EMAIL_RE = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
const LINKEDIN_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/(?:in|pub)\/[A-Za-z0-9._\-%]+/gi;
const TWITTER_RE = /https?:\/\/(?:www\.)?(?:twitter|x)\.com\/[A-Za-z0-9_]{1,15}(?![A-Za-z0-9_])/gi;
const CRUNCHBASE_RE = /https?:\/\/(?:www\.)?crunchbase\.com\/person\/[A-Za-z0-9._\-]+/gi;

function nameKeyOf(name: string | null | undefined): string | null {
  if (!name) return null;
  const s = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || null;
}

function safeName(s: string | null | undefined): string | null {
  if (!s) return null;
  const cleaned = s.replace(TAG_STRIP, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;
  // Strip "— Partner" / ", Partner" suffixes when callers inadvertently
  // pass "Jane Doe — Partner" as the name.
  const stripped = cleaned.split(/[\u2014\u2013|·•:,–—]| - /)[0].trim();
  return NAME_RE.test(stripped) ? stripped : null;
}

function looksLikeRole(s: string): boolean {
  const t = s.toLowerCase();
  return /(partner|principal|associate|analyst|advisor|director|venture|investor|founder|managing|operating|chief|ceo|cto|cfo|cmo|coo|head of)/.test(
    t,
  );
}

function pickRoleNear(text: string, name: string): string | null {
  // Look for "name — role", "name, role", or "name | role" in nearby text.
  const idx = text.indexOf(name);
  if (idx < 0) return null;
  const tail = text.slice(idx + name.length, idx + name.length + 200);
  const m = tail.match(/[\u2014\u2013|·•:,–—]\s*([A-Z][^.<>\n|]{2,80})/);
  if (m && looksLikeRole(m[1])) return m[1].trim();
  return null;
}

function absolutize(url: string, base?: string): string {
  if (!base) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

// ---------- Strategy 1: JSON-LD Person ----------
function extractJsonLdPersons(html: string, base?: string): ExtractedPerson[] {
  const out: ExtractedPerson[] = [];
  const re = /<script[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let parsed: unknown;
    try { parsed = JSON.parse(m[1].trim()); } catch { continue; }
    const stack: unknown[] = Array.isArray(parsed) ? [...parsed] : [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      const t = obj["@type"];
      const types = Array.isArray(t) ? t.map(String) : [String(t ?? "")];
      if (types.includes("Person")) {
        const name = safeName(typeof obj.name === "string" ? obj.name : null);
        if (!name) continue;
        const same = obj.sameAs;
        const sameAs = Array.isArray(same) ? same.map(String) : typeof same === "string" ? [same] : [];
        out.push({
          name,
          role: typeof obj.jobTitle === "string" ? obj.jobTitle : null,
          email: typeof obj.email === "string" ? String(obj.email).replace(/^mailto:/, "") : null,
          linkedin: sameAs.find((u) => /linkedin\.com/i.test(u)) ?? null,
          twitter: sameAs.find((u) => /(twitter|x)\.com/i.test(u)) ?? null,
          crunchbase: sameAs.find((u) => /crunchbase\.com/i.test(u)) ?? null,
          personal_site: typeof obj.url === "string" ? absolutize(obj.url, base) : null,
          avatar: typeof obj.image === "string" ? absolutize(obj.image, base) : null,
          bio: typeof obj.description === "string" ? obj.description : null,
          source_strategy: "jsonld_person",
        });
      }
      // Walk into common containers.
      for (const key of ["@graph", "member", "employee", "founder", "founders", "employees", "members"]) {
        const v = obj[key];
        if (Array.isArray(v)) stack.push(...v);
        else if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return out;
}

// ---------- Strategy 2: OpenGraph profile cards ----------
function extractOgProfile(html: string): ExtractedPerson[] {
  const og: Record<string, string> = {};
  const re = /<meta\s+[^>]*property\s*=\s*["'](og:profile:[^"']+|og:title)["'][^>]*content\s*=\s*["']([^"']+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) og[m[1].toLowerCase()] = m[2];
  const first = og["og:profile:first_name"];
  const last = og["og:profile:last_name"];
  const name = safeName([first, last].filter(Boolean).join(" "));
  if (!name) return [];
  return [{
    name,
    role: null,
    source_strategy: "og_profile",
  }];
}

// ---------- Strategy 3: Microformats (h-card / itemtype=Person) ----------
function extractMicroformats(html: string): ExtractedPerson[] {
  const out: ExtractedPerson[] = [];
  const re = /<([a-z]+)[^>]*(?:class\s*=\s*["'][^"']*\bh-card\b[^"']*["']|itemtype\s*=\s*["']https?:\/\/schema\.org\/Person["'])[^>]*>([\s\S]{0,4000}?)<\/\1>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const block = m[2];
    const nameMatch =
      block.match(/<[^>]+(?:class\s*=\s*["'][^"']*\b(?:p-name|fn)\b[^"']*["']|itemprop\s*=\s*["']name["'])[^>]*>([\s\S]*?)</i) ??
      block.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
    const name = safeName(nameMatch?.[1]);
    if (!name) continue;
    const roleMatch = block.match(/<[^>]+(?:class\s*=\s*["'][^"']*\b(?:p-job-title|role|title)\b[^"']*["']|itemprop\s*=\s*["']jobTitle["'])[^>]*>([\s\S]*?)</i);
    const linkedinMatch = block.match(LINKEDIN_RE);
    const emailMatch = block.match(EMAIL_RE);
    out.push({
      name,
      role: roleMatch?.[1]?.replace(TAG_STRIP, " ").replace(/\s+/g, " ").trim() ?? null,
      linkedin: linkedinMatch?.[0] ?? null,
      email: emailMatch?.[0]?.toLowerCase() ?? null,
      source_strategy: "microformat",
    });
  }
  return out;
}

// ---------- Strategy 4: LinkedIn anchor cluster ----------
function extractLinkedInCluster(html: string): ExtractedPerson[] {
  const matches = Array.from(html.matchAll(LINKEDIN_RE));
  if (matches.length < 3) return [];
  const out: ExtractedPerson[] = [];
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  for (const lm of matches) {
    const url = lm[0].replace(/[)\]>"',.;]+$/, "");
    const li = url.match(/\/in\/([A-Za-z0-9._\-%]+)/i)?.[1] ?? "";
    if (!li) continue;
    // Find the anchor in the original text and grab the visible label.
    const anchorRe = new RegExp(`<a[^>]*href\\s*=\\s*["']${url.replace(/[.*+?^${}()|[\\\]\\\\]/g, "\\$&")}["'][^>]*>([\\s\\S]*?)<\\/a>`, "i");
    const a = html.match(anchorRe);
    let name: string | null = null;
    if (a) name = safeName(a[1]);
    if (!name) {
      // Fall back to slug-derived name.
      const slug = decodeURIComponent(li).replace(/-+\d+$/, "").replace(/-/g, " ");
      name = safeName(slug.replace(/\b\w/g, (c) => c.toUpperCase()));
    }
    if (!name) continue;
    const role = pickRoleNear(text.replace(TAG_STRIP, " ").replace(/\s+/g, " "), name);
    out.push({ name, role, linkedin: url, source_strategy: "linkedin_cluster" });
  }
  return out;
}

// ---------- Strategy 5: image alt headshots ----------
function extractImageAlts(html: string, base?: string): ExtractedPerson[] {
  const out: ExtractedPerson[] = [];
  const re = /<img\s+[^>]*alt\s*=\s*["']([^"']{4,120})["'][^>]*src\s*=\s*["']([^"']+)["']/gi;
  const altFirstSrcSecond = re;
  // Also handle src-before-alt ordering.
  const re2 = /<img\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*alt\s*=\s*["']([^"']{4,120})["']/gi;
  for (const [r, altIdx, srcIdx] of [[altFirstSrcSecond, 1, 2], [re2, 2, 1]] as const) {
    let m: RegExpExecArray | null;
    while ((m = r.exec(html)) !== null) {
      const alt = m[altIdx];
      const src = m[srcIdx];
      // Headshot patterns: "Jane Doe", "Jane Doe - Partner", "Jane Doe, Partner".
      const namePart = alt.split(/[—–\-,|·•:]/)[0].trim();
      const name = safeName(namePart);
      if (!name) continue;
      const after = alt.slice(namePart.length + 1).trim();
      out.push({
        name,
        role: after && looksLikeRole(after) ? after : null,
        avatar: absolutize(src, base),
        source_strategy: "image_alt",
      });
    }
  }
  return out;
}

// ---------- Strategy 6: mailto + nearest heading ----------
function extractMailtoWithHeading(html: string): ExtractedPerson[] {
  const out: ExtractedPerson[] = [];
  const re = /<a\s+[^>]*href\s*=\s*["']mailto:([^"']+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const email = m[1].split("?")[0].toLowerCase().trim();
    if (!email.includes("@")) continue;
    const start = Math.max(0, m.index - 800);
    const before = html.slice(start, m.index);
    // Walk back to find the nearest <h1-6> or <strong> text.
    const heading = before.match(/<(?:h[1-6]|strong|b)[^>]*>([\s\S]{2,120}?)<\/(?:h[1-6]|strong|b)>(?![\s\S]*?<(?:h[1-6]|strong|b))/i);
    const linkText = m[2].replace(TAG_STRIP, " ").replace(/\s+/g, " ").trim();
    const name = safeName(heading?.[1]) ?? safeName(linkText);
    if (!name) continue;
    out.push({ name, email, source_strategy: "mailto_heading" });
  }
  return out;
}

// ---------- Strategy 7: email regex against firm domain(s) ----------
function extractEmailsForDomain(html: string, firmDomain: string | null): ExtractedPerson[] {
  if (!firmDomain) return [];
  const out: ExtractedPerson[] = [];
  const root = firmDomain.replace(/^www\./i, "").toLowerCase();
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ");
  const matches = Array.from(text.matchAll(EMAIL_RE));
  for (const em of matches) {
    const addr = em[0].toLowerCase();
    const dom = addr.split("@")[1] ?? "";
    if (!dom.endsWith(root)) continue;
    const local = addr.split("@")[0];
    if (/^(info|contact|hello|press|admin|support|jobs|careers|noreply|no-reply)$/.test(local)) continue;
    // Synthesize a candidate name from the local part.
    const guessName = local
      .split(/[._\-]+/)
      .filter(Boolean)
      .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
      .join(" ");
    const name = safeName(guessName);
    if (!name) continue;
    out.push({ name, email: addr, source_strategy: "email_regex" });
  }
  return out;
}

// ---------- Strategy 8: JSON blob scan ----------
function extractFromJsonBlobs(html: string): ExtractedPerson[] {
  const out: ExtractedPerson[] = [];
  const blobs: string[] = [];
  const reNext = /<script\s+id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;
  const m1 = html.match(reNext);
  if (m1) blobs.push(m1[1]);
  const reInit = /(?:__INITIAL_STATE__|__APOLLO_STATE__|__PRELOADED_STATE__)\s*=\s*(\{[\s\S]*?\});/g;
  let m: RegExpExecArray | null;
  while ((m = reInit.exec(html)) !== null) blobs.push(m[1]);

  for (const raw of blobs) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { continue; }
    const stack: unknown[] = [parsed];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== "object") continue;
      const obj = node as Record<string, unknown>;
      // Heuristic: any object with a name + (role|title|jobTitle|position).
      const nameStr = typeof obj.name === "string" ? obj.name : (typeof obj.fullName === "string" ? obj.fullName : null);
      const name = safeName(nameStr);
      const roleStr = ["role", "title", "jobTitle", "position"]
        .map((k) => (typeof obj[k] === "string" ? (obj[k] as string) : null))
        .find(Boolean) ?? null;
      if (name && roleStr && looksLikeRole(roleStr)) {
        out.push({
          name,
          role: roleStr,
          email: typeof obj.email === "string" ? (obj.email as string).toLowerCase() : null,
          linkedin: typeof obj.linkedin === "string" ? obj.linkedin as string : null,
          twitter: typeof obj.twitter === "string" ? obj.twitter as string : null,
          source_strategy: "json_blob",
        });
      }
      for (const v of Object.values(obj)) {
        if (Array.isArray(v)) stack.push(...v);
        else if (v && typeof v === "object") stack.push(v);
      }
    }
  }
  return out;
}

/**
 * Run all 8 strategies and return a per-page deduped list of people. The
 * caller is responsible for cross-page deduplication and for deciding which
 * fields to merge when the same name shows up on multiple pages.
 */
export function extractPeopleFromPage(
  html: string,
  pageUrl: string,
  firmDomain: string | null,
): ExtractedPerson[] {
  const all = [
    ...extractJsonLdPersons(html, pageUrl),
    ...extractOgProfile(html),
    ...extractMicroformats(html),
    ...extractLinkedInCluster(html),
    ...extractImageAlts(html, pageUrl),
    ...extractMailtoWithHeading(html),
    ...extractEmailsForDomain(html, firmDomain),
    ...extractFromJsonBlobs(html),
  ];

  // Sweep the full HTML for stray socials we can attach back to a name when
  // a strategy returned a name without a LinkedIn/Twitter/Crunchbase URL.
  const allLinkedins = Array.from(html.matchAll(LINKEDIN_RE)).map((m) => m[0]);
  const allTwitters = Array.from(html.matchAll(TWITTER_RE)).map((m) => m[0]);
  const allCrunchbases = Array.from(html.matchAll(CRUNCHBASE_RE)).map((m) => m[0]);

  // Dedupe + merge per nameKey.
  const byKey = new Map<string, ExtractedPerson>();
  for (const p of all) {
    const k = nameKeyOf(p.name);
    if (!k) continue;
    const cur = byKey.get(k);
    if (!cur) {
      byKey.set(k, { ...p });
      continue;
    }
    // Prefer non-null fields; multiple strategies on the same person
    // accumulate evidence here.
    cur.role ??= p.role;
    cur.email ??= p.email;
    cur.linkedin ??= p.linkedin;
    cur.twitter ??= p.twitter;
    cur.crunchbase ??= p.crunchbase;
    cur.personal_site ??= p.personal_site;
    cur.avatar ??= p.avatar;
    cur.bio ??= p.bio;
    cur.source_strategy = `${cur.source_strategy},${p.source_strategy}`;
  }

  // Try to attach a stray LinkedIn URL when the cluster strategy missed it
  // by matching slug to canonical name key.
  for (const li of allLinkedins) {
    const slug = li.match(/\/in\/([A-Za-z0-9._\-%]+)/i)?.[1] ?? "";
    if (!slug) continue;
    const decoded = decodeURIComponent(slug).replace(/-+\d+$/, "").replace(/-/g, " ");
    const key = nameKeyOf(decoded);
    if (!key) continue;
    const cur = byKey.get(key);
    if (cur && !cur.linkedin) cur.linkedin = li;
  }
  // Twitter handles by visible name proximity is too noisy; only attach
  // when there's exactly one twitter on the page.
  if (allTwitters.length === 1) {
    for (const p of byKey.values()) if (!p.twitter) { p.twitter = allTwitters[0]; break; }
  }
  if (allCrunchbases.length === 1) {
    for (const p of byKey.values()) if (!p.crunchbase) { p.crunchbase = allCrunchbases[0]; break; }
  }

  return Array.from(byKey.values());
}

export { nameKeyOf };
