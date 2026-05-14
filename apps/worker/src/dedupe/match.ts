// Match candidate leads against an incoming parsed lead. Returns the best
// match (if any) along with a score in [0,1] and reasons. Uses canonical_*
// indexed columns for exact lookups; we don't fuzzy-string in SQL because
// D1 lacks the trigram support for it.

import type { Lead } from "../db/leads.types";
import {
  canonicalEmailKey,
  canonicalLinkedinKey,
  canonicalNameCityKey,
  canonicalNameFirmKey,
  canonicalPhoneKey,
} from "./keys";

export interface MatchInput {
  email?: string | null;
  phone?: string | null;
  linkedin_url?: string | null;
  name?: string | null;
  org?: string | null;
  city?: string | null;
}

export interface MatchResult {
  candidate: Lead;
  score: number;
  reasons: string[];
}

const SQL_SELECT = "SELECT * FROM leads WHERE";
const NOT_MERGED = "(merged_into IS NULL OR merged_into = '')";

async function findOne(db: D1Database, column: string, value: string): Promise<Lead | null> {
  const r = await db
    .prepare(`${SQL_SELECT} ${column} = ? AND ${NOT_MERGED} ORDER BY created_at DESC LIMIT 1`)
    .bind(value)
    .first<Lead>();
  return r ?? null;
}

/**
 * Find the best matching existing lead, scoring 0..1.
 *  - email exact: 1.0
 *  - canonical LinkedIn exact: 0.95
 *  - phone exact: 0.9
 *  - name+firm exact: 0.75
 *  - name+city exact: 0.65
 */
export async function findMatch(db: D1Database, input: MatchInput): Promise<MatchResult | null> {
  const reasons: string[] = [];

  const emailKey = canonicalEmailKey(input.email);
  if (emailKey) {
    const c = await findOne(db, "canonical_email_key", emailKey);
    if (c) {
      reasons.push("email");
      return { candidate: c, score: 1.0, reasons };
    }
  }

  const linkedinKey = canonicalLinkedinKey(input.linkedin_url);
  if (linkedinKey) {
    const c = await findOne(db, "canonical_linkedin_key", linkedinKey);
    if (c) {
      reasons.push("linkedin");
      return { candidate: c, score: 0.95, reasons };
    }
  }

  const phoneKey = canonicalPhoneKey(input.phone);
  if (phoneKey) {
    const c = await findOne(db, "canonical_phone_key", phoneKey);
    if (c) {
      reasons.push("phone");
      return { candidate: c, score: 0.9, reasons };
    }
  }

  const nameFirmKey = canonicalNameFirmKey(input.name, input.org);
  if (nameFirmKey) {
    const c = await findOne(db, "canonical_name_firm_key", nameFirmKey);
    if (c) {
      reasons.push("name+firm");
      return { candidate: c, score: 0.75, reasons };
    }
  }

  const nameCityKey = canonicalNameCityKey(input.name, input.city);
  if (nameCityKey) {
    const c = await findOne(db, "canonical_name_city_key", nameCityKey);
    if (c) {
      reasons.push("name+city");
      return { candidate: c, score: 0.65, reasons };
    }
  }

  return null;
}
