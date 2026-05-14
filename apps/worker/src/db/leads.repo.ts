// Lead repository — single owner of UPDATEs to leads, with per-field audit
// rows written into lead_history. The pipeline + dedupe modules call
// updateLead() instead of issuing raw UPDATE statements so the audit trail
// stays consistent.

import type { Lead, LeadPatch } from "./leads.types";

export interface UpdateContext {
  source: string;
  evidence_url?: string | null;
  changed_by?: string | null;
}

const HISTORY_FIELDS: ReadonlyArray<keyof Lead> = [
  "name", "email", "phone", "org", "title", "category",
  "linkedin_url", "twitter_url", "github_url", "personal_url", "alt_emails_json",
  "persona_role", "seniority", "function_area", "bio",
  "gender", "age_range", "languages_json",
  "country_iso2", "region", "city", "timezone",
  "net_worth_band", "aum_usd", "fund_size_usd", "last_round_usd", "salary_band",
  "companies_json", "board_seats_json", "awards_json", "exits_json",
  "priority", "owner_email", "next_action_at", "tags_json", "sector_focus_json",
  "status", "verified", "flagged",
  "merged_into", "canonical_email_key", "canonical_phone_key",
  "canonical_linkedin_key", "canonical_name_firm_key", "canonical_name_city_key",
  "provider", "provider_score",
];

export class LeadsRepo {
  constructor(private db: D1Database) {}

  async getById(id: string): Promise<Lead | null> {
    const r = await this.db.prepare("SELECT * FROM leads WHERE id = ?").bind(id).first<Lead>();
    return r ?? null;
  }

  async insert(lead: Lead): Promise<void> {
    const rec = lead as unknown as Record<string, unknown>;
    const cols = Object.keys(rec);
    const placeholders = cols.map(() => "?").join(", ");
    const values = cols.map((c) => rec[c] ?? null);
    await this.db
      .prepare(`INSERT INTO leads (${cols.join(", ")}) VALUES (${placeholders})`)
      .bind(...values)
      .run();
  }

  /**
   * Patch a lead. Diffs old vs new on the configured set of fields, writes
   * one lead_history row per actual change (source, evidence_url, changed_by
   * provided by the caller). Returns the count of changed fields.
   */
  async updateLead(id: string, patch: LeadPatch, ctx: UpdateContext): Promise<number> {
    const before = await this.getById(id);
    if (!before) return 0;

    const changes: { field: string; oldValue: unknown; newValue: unknown }[] = [];
    const setParts: string[] = [];
    const setValues: unknown[] = [];

    const beforeRec = before as unknown as Record<string, unknown>;
    const patchRec = patch as unknown as Record<string, unknown>;
    for (const field of HISTORY_FIELDS) {
      if (!(field in patch)) continue;
      const next = patchRec[field];
      const prev = beforeRec[field];
      if (normalize(next) === normalize(prev)) continue;
      changes.push({ field, oldValue: prev, newValue: next });
      setParts.push(`${field} = ?`);
      setValues.push(next ?? null);
    }

    if (changes.length === 0) return 0;

    setParts.push("updated_at = ?");
    const now = new Date().toISOString();
    setValues.push(now);
    setValues.push(id);

    await this.db
      .prepare(`UPDATE leads SET ${setParts.join(", ")} WHERE id = ?`)
      .bind(...setValues)
      .run();

    const stmts = changes.map((ch) =>
      this.db
        .prepare(
          "INSERT INTO lead_history (id, lead_id, field, old_value, new_value, source, evidence_url, changed_by, changed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          crypto.randomUUID(),
          id,
          ch.field,
          ch.oldValue == null ? null : String(ch.oldValue),
          ch.newValue == null ? null : String(ch.newValue),
          ctx.source,
          ctx.evidence_url ?? null,
          ctx.changed_by ?? null,
          now,
        ),
    );
    await this.db.batch(stmts);
    return changes.length;
  }

  async history(id: string, limit = 200) {
    const r = await this.db
      .prepare(
        "SELECT id, field, old_value, new_value, source, evidence_url, changed_by, changed_at FROM lead_history WHERE lead_id = ? ORDER BY changed_at DESC LIMIT ?",
      )
      .bind(id, limit)
      .all();
    return r.results ?? [];
  }
}

function normalize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
