// Task #3: DD scan orchestrator.
//
// Runs every provider against one entity, normalises hits into
// `dd_findings`, recomputes the entity's risk + trust scores, and
// regenerates the AI executive summary. Idempotent: re-running the
// scan upserts findings on (entity, provider, source_url) so we don't
// duplicate, and resolves stale findings that no longer appear.

import type { Env } from "../types";
import { matchNames } from "./match";
import { queryOpenSanctions, classifySubtype, isPepHit, isSanctionHit } from "./providers/openSanctions";
import { searchSecEnforcement } from "./providers/secEdgar";
import { searchCourtListener } from "./providers/courtListener";
import { searchUkDisqualified } from "./providers/ukDisqualified";
import { scanAdverseMedia } from "./adverseMedia";
import { deriveGreenFlags } from "./greenFlags";
import { computeScores, type FindingForScore } from "./score";
import { generateAiSummary } from "./summary";

export interface EntityForScan {
  id: number;
  name: string;
  kind: string;                 // "person" | "firm" | "company" | ...
  aliases?: string[];
  bio?: string | null;
  linkedin_url?: string | null;
  twitter_url?: string | null;
  domain?: string | null;
  birth_date?: string | null;
  country?: string | null;
  email_verified?: boolean;
  firm_status?: string | null;
}

export interface ScanOptions {
  trigger?: "manual" | "cron" | "batch" | "workflow";
  triggered_by?: string | null;
  providers?: string[];          // override which providers to run
  enableAi?: boolean;             // AI arbitration + summary
  matchThreshold?: number;        // composite match score threshold for sanctions
}

export interface ScanResult {
  scan_id: string;
  status: "ok" | "partial" | "failed";
  duration_ms: number;
  providers_attempted: string[];
  providers_failed: string[];
  findings_added: number;
  findings_resolved: number;
  risk_score: number;
  trust_score: number;
  risk_band: string;
}

const DEFAULT_PROVIDERS = ["opensanctions", "sec_edgar", "courtlistener", "uk_disqualified", "gdelt_adverse_media", "green_flags"];

function severityFromTopic(topics: string[]): "low" | "medium" | "high" | "critical" {
  if (topics.some((t) => t === "sanction" || t.startsWith("sanction.") || t.startsWith("crime.terror"))) return "critical";
  if (topics.some((t) => t.startsWith("crime"))) return "high";
  if (topics.some((t) => t === "role.pep")) return "medium";
  return "medium";
}

async function upsertFinding(env: Env, row: {
  entity_id: number;
  finding_type: string;
  finding_subtype?: string | null;
  source_provider: string;
  source_url?: string | null;
  source_payload_r2_key?: string | null;
  match_score?: number | null;
  match_method?: string | null;
  match_evidence_json?: string | null;
  title: string;
  description?: string | null;
  severity: string;
  observed_at?: string;
}): Promise<{ inserted: boolean }>{
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    `INSERT INTO dd_findings (
       entity_id, finding_type, finding_subtype, source_provider, source_url,
       source_payload_r2_key, match_score, match_method, match_evidence_json,
       title, description, severity, observed_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id, source_provider, COALESCE(source_url,''), COALESCE(finding_subtype,'')) DO UPDATE SET
       title = excluded.title,
       description = excluded.description,
       severity = excluded.severity,
       match_score = excluded.match_score,
       match_method = excluded.match_method,
       match_evidence_json = excluded.match_evidence_json,
       observed_at = excluded.observed_at,
       updated_at = excluded.updated_at,
       status = CASE WHEN dd_findings.status = 'resolved' THEN 'open' ELSE dd_findings.status END`,
  ).bind(
    row.entity_id,
    row.finding_type,
    row.finding_subtype ?? null,
    row.source_provider,
    row.source_url ?? null,
    row.source_payload_r2_key ?? null,
    row.match_score ?? null,
    row.match_method ?? null,
    row.match_evidence_json ?? null,
    row.title.slice(0, 500),
    row.description?.slice(0, 4000) ?? null,
    row.severity,
    row.observed_at ?? now,
    now,
    now,
  ).run();
  return { inserted: Number(r.meta?.changes ?? 0) > 0 };
}

async function resolveStaleForProvider(env: Env, entityId: number, provider: string, freshKeys: Array<{ url: string | null; subtype: string | null }>, scanStartedAt: string): Promise<number> {
  // Anything from this provider not seen in this scan, still open, gets
  // flagged 'resolved'. The dedupe key in dd_findings is
  // (entity_id, source_provider, COALESCE(source_url,''), COALESCE(finding_subtype,''))
  // so stale resolution must key on the *same* tuple to converge.
  const now = new Date().toISOString();
  if (freshKeys.length === 0) {
    const r = await env.DB.prepare(
      `UPDATE dd_findings SET status = 'resolved', updated_at = ?
         WHERE entity_id = ? AND source_provider = ? AND status = 'open' AND observed_at < ?`,
    ).bind(now, entityId, provider, scanStartedAt).run();
    return Number(r.meta?.changes ?? 0);
  }
  const tuples = freshKeys.map(() => "(?, ?)").join(",");
  const flat: Array<string> = [];
  for (const k of freshKeys) { flat.push(k.url ?? "", k.subtype ?? ""); }
  const r = await env.DB.prepare(
    `UPDATE dd_findings SET status = 'resolved', updated_at = ?
       WHERE entity_id = ? AND source_provider = ? AND status = 'open'
         AND observed_at < ?
         AND (COALESCE(source_url,''), COALESCE(finding_subtype,'')) NOT IN (VALUES ${tuples})`,
  ).bind(now, entityId, provider, scanStartedAt, ...flat).run();
  return Number(r.meta?.changes ?? 0);
}

export async function scanEntity(env: Env, entity: EntityForScan, opts: ScanOptions = {}): Promise<ScanResult> {
  const scan_id = crypto.randomUUID();
  const t0 = Date.now();
  const startedAt = new Date().toISOString();
  const providers = opts.providers ?? DEFAULT_PROVIDERS;
  const trigger = opts.trigger ?? "manual";
  const enableAi = opts.enableAi ?? true;
  const matchThreshold = opts.matchThreshold ?? 0.7;

  await env.DB.prepare(
    `INSERT INTO dd_scan_runs (id, entity_id, trigger, triggered_by, status, started_at)
     VALUES (?, ?, ?, ?, 'running', ?)`,
  ).bind(scan_id, entity.id, trigger, opts.triggered_by ?? null, startedAt).run();

  const attempted: string[] = [];
  const failed: string[] = [];
  let added = 0;
  let resolved = 0;

  // ---- 1. OpenSanctions consolidated (covers OFAC/EU/UN/UK HMT/Interpol/etc) ----
  if (providers.includes("opensanctions")) {
    attempted.push("opensanctions");
    try {
      const r = await queryOpenSanctions(env, {
        name: entity.name,
        schema: entity.kind === "person" ? "Person" : "Organization",
        aliases: entity.aliases,
        birthDate: entity.birth_date ?? undefined,
        country: entity.country ?? undefined,
      });
      if (!r.ok) {
        failed.push("opensanctions");
      } else {
        const freshKeys: Array<{ url: string | null; subtype: string | null }> = [];
        for (const m of r.matches) {
          const match = await matchNames(env, { name: entity.name, aliases: entity.aliases }, { name: m.caption, aliases: m.aliases }, {
            enableAi,
            aiContextA: entity.bio ?? undefined,
            aiContextB: m.topics.join(", "),
          });
          if (match.score < matchThreshold) continue;
          const isSanction = isSanctionHit(m.topics);
          const isPep = isPepHit(m.topics);
          if (!isSanction && !isPep) continue;
          const finding_type = isSanction ? "sanction" : "pep";
          const subtype = isSanction ? classifySubtype(m.datasets) : "pep";
          const severity = isSanction ? severityFromTopic(m.topics) : "medium";
          const title = `${isSanction ? "Sanctions match" : "PEP match"}: ${m.caption}`;
          const description = `Datasets: ${m.datasets.join(", ")}. Topics: ${m.topics.join(", ")}.`;
          const url = m.url ?? `https://www.opensanctions.org/entities/${m.id}/`;
          const r2 = await archivePayload(env, scan_id, "opensanctions", m as unknown as Record<string, unknown>);
          const { inserted } = await upsertFinding(env, {
            entity_id: entity.id,
            finding_type,
            finding_subtype: subtype,
            source_provider: "opensanctions",
            source_url: url,
            source_payload_r2_key: r2,
            match_score: match.score,
            match_method: match.method,
            match_evidence_json: JSON.stringify(match.evidence),
            title,
            description,
            severity,
          });
          if (inserted) added += 1;
          freshKeys.push({ url, subtype });
        }
        resolved += await resolveStaleForProvider(env, entity.id, "opensanctions", freshKeys, startedAt);
      }
    } catch (e) {
      console.warn("scan opensanctions failed", (e as Error).message);
      failed.push("opensanctions");
    }
  }

  // ---- 2. SEC EDGAR enforcement ----
  if (providers.includes("sec_edgar")) {
    attempted.push("sec_edgar");
    try {
      const r = await searchSecEnforcement(env, entity.name, { limit: 10 });
      if (!r.ok) failed.push("sec_edgar");
      else {
        const freshKeys: Array<{ url: string | null; subtype: string | null }> = [];
        for (const h of r.hits) {
          const m = await matchNames(env, { name: entity.name }, { name: h.title }, { enableAi: false });
          // For SEC, the candidate's name has to appear in the filing
          // title to count. Lower threshold (0.6) since titles often
          // include third-party text.
          if (m.score < 0.6) continue;
          const { inserted } = await upsertFinding(env, {
            entity_id: entity.id,
            finding_type: "enforcement",
            finding_subtype: h.form.toLowerCase().replace(/\s+/g, "_"),
            source_provider: "sec_edgar",
            source_url: h.url,
            match_score: m.score,
            match_method: m.method,
            match_evidence_json: JSON.stringify(m.evidence),
            title: `SEC ${h.form}: ${h.title}`,
            description: `Filed ${h.filed_at}`,
            severity: "high",
          });
          if (inserted) added += 1;
          freshKeys.push({ url: h.url, subtype: h.form.toLowerCase().replace(/\s+/g, "_") });
        }
        resolved += await resolveStaleForProvider(env, entity.id, "sec_edgar", freshKeys, startedAt);
      }
    } catch (e) {
      console.warn("scan sec_edgar failed", (e as Error).message);
      failed.push("sec_edgar");
    }
  }

  // ---- 3. CourtListener (federal/state US court cases) ----
  if (providers.includes("courtlistener")) {
    attempted.push("courtlistener");
    try {
      const r = await searchCourtListener(env, entity.name, { limit: 10 });
      if (!r.ok) failed.push("courtlistener");
      else {
        const freshKeys: Array<{ url: string | null; subtype: string | null }> = [];
        for (const h of r.hits) {
          const m = await matchNames(env, { name: entity.name }, { name: h.caseName }, { enableAi: false });
          if (m.score < 0.65) continue;
          const { inserted } = await upsertFinding(env, {
            entity_id: entity.id,
            finding_type: "court_case",
            finding_subtype: h.court,
            source_provider: "courtlistener",
            source_url: h.absolute_url,
            match_score: m.score,
            match_method: m.method,
            match_evidence_json: JSON.stringify(m.evidence),
            title: h.caseName,
            description: `${h.court} • filed ${h.dateFiled}${h.docketNumber ? ` • ${h.docketNumber}` : ""}`,
            severity: "medium",
          });
          if (inserted) added += 1;
          freshKeys.push({ url: h.absolute_url, subtype: h.court });
        }
        resolved += await resolveStaleForProvider(env, entity.id, "courtlistener", freshKeys, startedAt);
      }
    } catch (e) {
      console.warn("scan courtlistener failed", (e as Error).message);
      failed.push("courtlistener");
    }
  }

  // ---- 4. UK Companies House disqualified officers (only if API key set) ----
  if (providers.includes("uk_disqualified")) {
    try {
      const r = await searchUkDisqualified(env, entity.name, { limit: 10 });
      if (r.skipped) {
        // not attempted — no key
      } else {
        attempted.push("uk_disqualified");
        if (!r.ok) failed.push("uk_disqualified");
        else {
          const freshKeys: Array<{ url: string | null; subtype: string | null }> = [];
          for (const h of r.hits) {
            const m = await matchNames(env, { name: entity.name }, { name: h.name }, { enableAi: false });
            if (m.score < 0.75) continue;
            const { inserted } = await upsertFinding(env, {
              entity_id: entity.id,
              finding_type: "disqualified_director",
              finding_subtype: "uk_companies_house",
              source_provider: "uk_companies_house",
              source_url: h.disqualification_url,
              match_score: m.score,
              match_method: m.method,
              match_evidence_json: JSON.stringify(m.evidence),
              title: `Disqualified director: ${h.name}`,
              description: h.date_of_birth ? `DOB: ${h.date_of_birth}` : undefined,
              severity: "high",
            });
            if (inserted) added += 1;
            freshKeys.push({ url: h.disqualification_url, subtype: "uk_companies_house" });
          }
          resolved += await resolveStaleForProvider(env, entity.id, "uk_companies_house", freshKeys, startedAt);
        }
      }
    } catch (e) {
      console.warn("scan uk_disqualified failed", (e as Error).message);
      failed.push("uk_disqualified");
    }
  }

  // ---- 5. Adverse media (GDELT + optional NewsAPI) ----
  if (providers.includes("gdelt_adverse_media")) {
    attempted.push("gdelt_adverse_media");
    try {
      const hits = await scanAdverseMedia(env, { name: entity.name }, { topK: 10, sinceDays: 365 });
      const freshKeys: Array<{ url: string | null; subtype: string | null }> = [];
      for (const h of hits) {
        const { inserted } = await upsertFinding(env, {
          entity_id: entity.id,
          finding_type: "adverse_media",
          finding_subtype: h.matched_keywords.slice(0, 3).join(","),
          source_provider: "gdelt",
          source_url: h.url,
          match_score: h.severity_score,
          match_method: "fuzzy",
          match_evidence_json: JSON.stringify({ reputability: h.reputability, keywords: h.matched_keywords }),
          title: h.title,
          description: `Domain: ${h.domain} (rep ${h.reputability.toFixed(2)}). Keywords: ${h.matched_keywords.join(", ")}.${h.published_at ? ` Published ${h.published_at}.` : ""}`,
          severity: h.severity,
        });
        if (inserted) added += 1;
        freshKeys.push({ url: h.url, subtype: h.matched_keywords.slice(0, 3).join(",") });
      }
      resolved += await resolveStaleForProvider(env, entity.id, "gdelt", freshKeys, startedAt);
    } catch (e) {
      console.warn("scan adverse_media failed", (e as Error).message);
      failed.push("gdelt_adverse_media");
    }
  }

  // ---- 6. Green flags (derived from entity hints) ----
  if (providers.includes("green_flags")) {
    attempted.push("green_flags");
    try {
      const flags = await deriveGreenFlags(env, {
        bio: entity.bio,
        linkedin_url: entity.linkedin_url,
        twitter_url: entity.twitter_url,
        domain: entity.domain,
        email_verified: entity.email_verified,
        firm_status: entity.firm_status,
      });
      for (const f of flags) {
        const { inserted } = await upsertFinding(env, {
          entity_id: entity.id,
          finding_type: "green_flag",
          finding_subtype: f.source,
          source_provider: "internal",
          source_url: f.url ?? `internal:${f.source}:${entity.id}`,
          title: f.title,
          description: f.description,
          severity: f.severity,
        });
        if (inserted) added += 1;
      }
    } catch (e) {
      console.warn("scan green_flags failed", (e as Error).message);
      failed.push("green_flags");
    }
  }

  // ---- 7. Task #3: profile classifier PEP signal ----
  // If our public-persona classifier flagged this entity as a PEP
  // (entity_profile_axes.is_pep = 1) and OpenSanctions did not already
  // surface a PEP match, raise a synthetic medium-severity finding so
  // the DD score reflects it. Provider = "profile_classifier".
  try {
    const axes = await env.DB.prepare(
      `SELECT is_pep, is_government_official, primary_type, classified_at, classifier_version
         FROM entity_profile_axes WHERE entity_id = ?`,
    ).bind(entity.id).first<{ is_pep: number | null; is_government_official: number | null; primary_type: string | null; classified_at: string | null; classifier_version: string | null }>();
    if (axes && axes.is_pep === 1) {
      const existing = await env.DB.prepare(
        `SELECT 1 FROM dd_findings
          WHERE entity_id = ? AND finding_type = 'pep'
            AND source_provider = 'opensanctions'
            AND status IN ('open','confirmed')
          LIMIT 1`,
      ).bind(entity.id).first<{ 1: number }>();
      if (!existing) {
        const description = `Classified as PEP by ${axes.classifier_version ?? "profile_classifier"}` +
          (axes.primary_type ? ` (primary type: ${axes.primary_type})` : "") +
          (axes.is_government_official === 1 ? `; current government official.` : "") +
          (axes.classified_at ? ` Classified at ${axes.classified_at}.` : "");
        const { inserted } = await upsertFinding(env, {
          entity_id: entity.id,
          finding_type: "pep",
          finding_subtype: "profile_classifier",
          source_provider: "profile_classifier",
          source_url: `internal:profile_classifier:${entity.id}`,
          title: `PEP (profile classifier): ${entity.name}`,
          description,
          severity: "medium",
        });
        if (inserted) added += 1;
      }
    }
  } catch (e) {
    console.warn("scan profile_classifier pep hook failed", (e as Error).message);
  }

  // ---- Recompute score from the live findings ----
  const all = await env.DB.prepare(
    `SELECT finding_type, severity, status, match_score FROM dd_findings WHERE entity_id = ?`,
  ).bind(entity.id).all<FindingForScore>();
  const score = computeScores(all.results ?? []);

  // ---- AI executive summary ----
  let aiSummary: { summary: string | null; model: string | null } = { summary: null, model: null };
  if (enableAi) {
    const top = await env.DB.prepare(
      `SELECT finding_type, finding_subtype, severity, title, source_provider, match_score
         FROM dd_findings
        WHERE entity_id = ? AND status IN ('open','confirmed')
        ORDER BY CASE severity WHEN 'critical' THEN 4 WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END DESC,
                 observed_at DESC
        LIMIT 12`,
    ).bind(entity.id).all<{ finding_type: string; finding_subtype: string | null; severity: string; title: string; source_provider: string; match_score: number | null }>();
    aiSummary = await generateAiSummary(env, {
      entity_name: entity.name,
      risk_score: score.risk_score,
      trust_score: score.trust_score,
      risk_band: score.risk_band,
      components: score.components as unknown as Record<string, number>,
      findings: top.results ?? [],
    });
  }

  // ---- Persist entity_risk_scores ----
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO entity_risk_scores (
       entity_id, risk_score, trust_score, risk_band,
       sanctions_count, pep_count, adverse_media_count, court_case_count, enforcement_count, green_flag_count,
       components_json, ai_summary, ai_summary_model, ai_summary_generated_at,
       last_scan_id, last_scan_at, last_scan_duration_ms, providers_scanned_json,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       risk_score = excluded.risk_score,
       trust_score = excluded.trust_score,
       risk_band = excluded.risk_band,
       sanctions_count = excluded.sanctions_count,
       pep_count = excluded.pep_count,
       adverse_media_count = excluded.adverse_media_count,
       court_case_count = excluded.court_case_count,
       enforcement_count = excluded.enforcement_count,
       green_flag_count = excluded.green_flag_count,
       components_json = excluded.components_json,
       ai_summary = COALESCE(excluded.ai_summary, entity_risk_scores.ai_summary),
       ai_summary_model = COALESCE(excluded.ai_summary_model, entity_risk_scores.ai_summary_model),
       ai_summary_generated_at = COALESCE(excluded.ai_summary_generated_at, entity_risk_scores.ai_summary_generated_at),
       last_scan_id = excluded.last_scan_id,
       last_scan_at = excluded.last_scan_at,
       last_scan_duration_ms = excluded.last_scan_duration_ms,
       providers_scanned_json = excluded.providers_scanned_json,
       updated_at = excluded.updated_at`,
  ).bind(
    entity.id, score.risk_score, score.trust_score, score.risk_band,
    score.counts.sanctions_count, score.counts.pep_count, score.counts.adverse_media_count,
    score.counts.court_case_count, score.counts.enforcement_count, score.counts.green_flag_count,
    JSON.stringify(score.components),
    aiSummary.summary, aiSummary.model, aiSummary.summary ? now : null,
    scan_id, now, Date.now() - t0, JSON.stringify(attempted),
    now, now,
  ).run();

  const status: ScanResult["status"] = failed.length === 0 ? "ok" : (failed.length < attempted.length ? "partial" : "failed");
  const duration_ms = Date.now() - t0;
  await env.DB.prepare(
    `UPDATE dd_scan_runs SET
       status = ?, providers_attempted_json = ?, providers_failed_json = ?,
       findings_added = ?, findings_resolved = ?, duration_ms = ?, finished_at = ?
     WHERE id = ?`,
  ).bind(status, JSON.stringify(attempted), JSON.stringify(failed), added, resolved, duration_ms, now, scan_id).run();

  return {
    scan_id, status, duration_ms,
    providers_attempted: attempted, providers_failed: failed,
    findings_added: added, findings_resolved: resolved,
    risk_score: score.risk_score, trust_score: score.trust_score, risk_band: score.risk_band,
  };
}

async function archivePayload(env: Env, scanId: string, provider: string, payload: Record<string, unknown>): Promise<string | null> {
  if (!env.RAW_HTML) return null;
  try {
    const key = `dd-payloads/${provider}/${scanId}/${crypto.randomUUID()}.json`;
    await env.RAW_HTML.put(key, JSON.stringify(payload), { httpMetadata: { contentType: "application/json" } });
    return key;
  } catch {
    return null;
  }
}

// ---- Helper: load an entity for scanning from the graph + linked rows ----

export async function loadEntityForScan(env: Env, entityId: number): Promise<EntityForScan | null> {
  const ent = await env.DB.prepare(
    `SELECT id, kind, ref_table, ref_id, name FROM entities WHERE id = ?`,
  ).bind(entityId).first<{ id: number; kind: string; ref_table: string | null; ref_id: string | null; name: string }>();
  if (!ent) return null;
  const out: EntityForScan = { id: ent.id, name: ent.name, kind: ent.kind };
  if (ent.ref_table === "leads" && ent.ref_id) {
    const lead = await env.DB.prepare(
      `SELECT bio, linkedin_url, twitter_url, email, email_status, country_iso2 FROM leads WHERE id = ?`,
    ).bind(ent.ref_id).first<{ bio: string | null; linkedin_url: string | null; twitter_url: string | null; email: string | null; email_status: string | null; country_iso2: string | null }>();
    if (lead) {
      out.bio = lead.bio;
      out.linkedin_url = lead.linkedin_url;
      out.twitter_url = lead.twitter_url;
      out.country = lead.country_iso2 ?? undefined;
      out.email_verified = lead.email_status === "verified" || lead.email_status === "valid";
    }
  } else if ((ent.ref_table === "firms" || ent.ref_table === "companies") && ent.ref_id) {
    const firm = await env.DB.prepare(
      `SELECT domain, status FROM ${ent.ref_table} WHERE id = ?`,
    ).bind(ent.ref_id).first<{ domain: string | null; status: string | null }>().catch(() => null);
    if (firm) {
      out.domain = firm.domain;
      out.firm_status = firm.status;
    }
  }
  return out;
}
