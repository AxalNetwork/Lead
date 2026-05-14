// Crunchbase person profile parser. Targets the JSON payload Crunchbase
// embeds in `<script id="__NEXT_DATA__">` rather than the noisy HTML title.
// Falls back to the title-only heuristic the legacy parser used so the
// flow degrades gracefully when Crunchbase changes its template.

import type { ParsedLead } from "../../../types";
import { extractDomain } from "../../normalize";
import { extractTitle, extractSocialLinks } from "../../html";

const NEXT_DATA_RE = /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i;

interface NextDataNode {
  identifier?: { permalink?: string; uuid?: string; value?: string };
  current_title?: string;
  primary_organization?: { value?: string; identifier?: { value?: string; permalink?: string } };
  location_identifiers?: Array<{ value?: string }>;
  websites?: Array<{ value?: string }>;
  twitter?: { value?: string };
  linkedin?: { value?: string };
  facebook?: { value?: string };
  short_description?: string;
  description?: string;
}

function digForPersonNode(obj: unknown, depth = 0): NextDataNode | null {
  if (!obj || typeof obj !== "object" || depth > 8) return null;
  const o = obj as Record<string, unknown>;
  // Heuristic: a Crunchbase person card has both `identifier` and one of
  // `current_title` / `primary_organization`.
  if (o.identifier && (o.current_title || o.primary_organization)) {
    return o as unknown as NextDataNode;
  }
  for (const v of Object.values(o)) {
    if (Array.isArray(v)) {
      for (const item of v) {
        const hit = digForPersonNode(item, depth + 1);
        if (hit) return hit;
      }
    } else if (v && typeof v === "object") {
      const hit = digForPersonNode(v, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

function extractFromNextData(html: string): NextDataNode | null {
  const m = NEXT_DATA_RE.exec(html);
  if (!m) return null;
  try {
    const json = JSON.parse(m[1]);
    return digForPersonNode(json);
  } catch {
    return null;
  }
}

export function isCrunchbasePersonUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /(^|\.)crunchbase\.com$/i.test(u.hostname) && /^\/person\/[^/]+/i.test(u.pathname);
  } catch {
    return false;
  }
}

export function parseCrunchbasePerson(html: string, url: string): ParsedLead[] {
  const source_domain = extractDomain(url);
  const node = extractFromNextData(html);
  const socials = extractSocialLinks(html, url);

  let name: string | undefined;
  let title: string | undefined;
  let org: string | undefined;
  let location: string | undefined;
  let bio: string | undefined;
  let identifier: string | undefined;

  if (node) {
    const idVal = node.identifier?.value || node.identifier?.permalink;
    if (idVal) {
      identifier = idVal;
      // identifier.value on Crunchbase is the display name on person nodes.
      if (node.identifier?.value) name = node.identifier.value;
    }
    title = node.current_title || undefined;
    org = node.primary_organization?.value || node.primary_organization?.identifier?.value || undefined;
    location = (node.location_identifiers || []).map((l) => l.value).filter(Boolean).join(", ") || undefined;
    bio = node.short_description || node.description || undefined;

    // Add socials surfaced by NEXT_DATA that the anchor scan may miss.
    const pushSocial = (platform: string, raw: string | undefined) => {
      if (!raw) return;
      const u = raw.startsWith("http") ? raw : `https://${raw}`;
      if (!socials.find((s) => s.url.toLowerCase() === u.toLowerCase())) {
        socials.push({ platform, url: u });
      }
    };
    pushSocial("twitter", node.twitter?.value);
    pushSocial("linkedin", node.linkedin?.value);
    pushSocial("facebook", node.facebook?.value);
    for (const w of node.websites || []) pushSocial("website", w.value);
  }

  // Title-fallback when __NEXT_DATA__ is missing or trimmed.
  if (!name) {
    const pageTitle = extractTitle(html);
    if (pageTitle) {
      const m = /^([^-|]+?)\s*-\s*([^|]+?)(?:\s*\|\s*Crunchbase)?$/.exec(pageTitle);
      if (m) {
        name = m[1].trim();
        const tail = m[2].trim().split(",").map((s) => s.trim());
        title ??= tail[0];
        org ??= tail[1];
      } else {
        name = pageTitle.replace(/\s*\|\s*Crunchbase.*$/i, "").trim();
      }
    }
  }

  return [
    {
      source_domain,
      source_url: url,
      name,
      title,
      org,
      category: "crunchbase_profile",
      meta: {
        parser: "profile/crunchbase-person",
        identifier,
        location,
        bio,
        socials,
      },
    },
  ];
}
