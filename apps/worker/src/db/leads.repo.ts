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
  "status", "verified", "flagged", "approved_at", "approved_by",
  "merged_into", "canonical_email_key", "canonical_phone_key",
  "canonical_linkedin_key", "canonical_name_firm_key", "canonical_name_city_key",
  "provider", "provider_score",
  "sector_slug", "geo_slug", "do_not_contact",
  // Task #24 investor columns — auditable so enrichment writes show up
  // in lead_history and trigger profile cache invalidation.
  "investor_kind", "check_size_min_usd", "check_size_max_usd",
  "check_size_typical_usd", "sweet_spot_stage", "stage_focus_json",
  "sector_focus_slugs_json", "geo_focus_json", "thesis",
  "office_hours_url", "pitch_form_url", "calendly_url",
  "signal_nfx_url", "crunchbase_url", "wikipedia_url",
  "current_fund_id", "current_role_title",
  "board_seats_count", "media_count", "podcast_count",
  "portfolio_logos_json",
  "investment_count", "unicorn_count", "exit_count",
  "avg_check_usd", "total_deployed_usd",
];

// Optional KV binding so updateLead() can bust the investor profile cache
// (Task #24). Plain D1Database is still accepted to keep callers that don't
// need cache invalidation simple.
export interface LeadsRepoCacheEnv {
  SCRAPE_CACHE?: KVNamespace;
}

export class LeadsRepo {
  private cacheKv: KVNamespace | null;
  constructor(private db: D1Database, cacheEnv?: LeadsRepoCacheEnv) {
    this.cacheKv = cacheEnv?.SCRAPE_CACHE ?? null;
  }

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
   * Patch a lead. Diffs old vs new on the configured set of fields
   * (`HISTORY_FIELDS`), writes one lead_history row per actual change
   * (source, evidence_url, changed_by provided by the caller), and returns
   * the count of changed fields.
   *
   * Contract note: patch keys NOT in `HISTORY_FIELDS` are silently ignored.
   * If you add a new tracked column to `leads`, add it to `HISTORY_FIELDS`
   * here so updates persist and audit rows are written.
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

    // Task #24: deterministically bust the cached investor profile so the
    // dashboard re-fetches fresh data after any audited mutation. We only
    // bust when the lead is an investor (investor_kind set) to avoid the
    // KV write on the much larger non-investor lead population.
    if (this.cacheKv) {
      const beforeRecForKind = before as unknown as Record<string, unknown>;
      const afterKind = patchRec.investor_kind ?? beforeRecForKind.investor_kind;
      if (afterKind) {
        try {
          await this.cacheKv.delete(`profile:investor:${id}`);
        } catch (e) {
          console.warn("profile cache bust failed", id, (e as Error).message);
        }
      }
    }
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
