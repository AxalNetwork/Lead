// Task #4: Monday capital-markets weekly digest — per-user-tz delivery
// with watchlist-scoped personalization.
//
// Delivery cadence: the nightly cron tick ("15 3 * * *" UTC, Free plan
// caps crons at 5/5) iterates every recipient and sends only if the
// most recent "Monday 09:00 local" instant in that user's IANA tz falls
// within the past 24h. Because the cron fires once per day, this
// produces exactly one send per user per week (the spec's "Monday 9 AM
// local" guarantee).
//
// Personalization: each section is filtered against the recipient's
// watchlist_members entity_ids. Empty sections fall back to the
// platform-global top-N so no recipient ever gets an all-empty email
// (acceptance probe #7 — "renders for a user with ≥1 watchlist and
// contains all four sections").

import type { Env } from "../types";
import { deliverEmail } from "./channels/email";
import { loadDigestPrefs, type UserDigestPrefs } from "./schedule";

interface Deal {
  id: string; company_name_raw: string; company_entity_id: string | null;
  amount_usd: number | null; round_name: string | null;
  announcement_date: string | null; event_type: string; source_url: string | null;
}
interface Move {
  id: string; person_name_raw: string; movement_type: string;
  person_entity_id: string | null;
  from_firm_entity_id: string | null; to_firm_entity_id: string | null;
  to_title: string | null; observed_at: string;
}
interface Fund {
  id: string; fund_name: string; firm_entity_id: string;
  target_size_usd: number | null; strategy: string | null;
  fund_status: string; created_at: string;
}
interface Commit {
  lp_name: string | null; lp_entity_id: string;
  fund_entity_id: string | null; fund_name_raw: string;
  committed_usd: number; vintage_year: number | null; as_of_date: string;
}

export async function runCapitalMarketsWeeklyDigest(env: Env): Promise<{
  recipients: number; sent: number; skipped_offwindow: number; failed: number;
}> {
  const recips = await env.DB.prepare(
    `SELECT DISTINCT owner_email FROM watchlists ORDER BY owner_email LIMIT 500`,
  ).all<{ owner_email: string }>();
  const recipients = (recips.results ?? []).map((r) => r.owner_email);
  if (!recipients.length) return { recipients: 0, sent: 0, skipped_offwindow: 0, failed: 0 };

  const now = new Date();
  let sent = 0, failed = 0, skipped = 0;
  for (const email of recipients) {
    const prefs = await loadDigestPrefs(env, email);
    if (!isInUserMondayWindow(now, prefs)) { skipped++; continue; }
    // Per-recipient try/catch — one bad query or send must not abort
    // the entire batch.
    try {
      const memberIds = await loadWatchlistEntityIds(env, email);
      const html = await renderForRecipient(env, memberIds);
      const res = await deliverEmail(env, {
        to: [email],
        subject: "Last week in your capital-markets watch",
        title: "Last week in your capital-markets watch",
        bodyHtml: html,
      });
      if (res.ok) sent++; else failed++;
    } catch (e) {
      console.warn("capital-markets digest send failed", email, (e as Error).message);
      failed++;
    }
  }
  return { recipients: recipients.length, sent, skipped_offwindow: skipped, failed };
}

// Returns true when `now` is within the 24h window starting at the
// most recent "Monday digest_hour:00 local" instant in the user's tz.
// Compute the anchor directly from the local wall-clock date — walking
// back 24h blocks then comparing the local hour wrongly excludes users
// where the cron runs before their local digest hour (e.g. cron 03:15
// UTC = 08:15 local at UTC+5 on Monday: a back=0 candidate has hour=8 <
// 9 and gets skipped even though Monday 09:00 local is just 45m away).
// We compute the most-recent Monday on or before "today (local)" and
// take its hour:00 local instant; if it's in the future, step back 7
// days; then check the 24h window.
export function isInUserMondayWindow(now: Date, prefs: UserDigestPrefs): boolean {
  const tz = prefs.timezone || "UTC";
  const hour = clampHour(prefs.digest_hour);
  const todayParts = getLocalParts(now, tz);
  if (!todayParts) return false;
  // Step back from today (local) to the most-recent Monday (isoWeekday=1).
  // todayParts.isoWeekday is 1..7; back = (isoWeekday - 1) days.
  const stepDays = (todayParts.isoWeekday + 6) % 7; // 0 if Mon, 1 if Tue, …, 6 if Sun
  // The local-calendar date of that Monday.
  const monMidnightLocalApprox = new Date(now.getTime() - stepDays * 86_400_000);
  const monParts = getLocalParts(monMidnightLocalApprox, tz);
  if (!monParts) return false;
  // Build the exact UTC instant for {monParts.year-month-day, hour:00, tz}.
  let anchor = utcForLocalDate(monParts.year, monParts.month, monParts.day, hour, tz);
  if (!anchor) return false;
  // If that anchor is still in the future relative to now (can happen
  // for cron-before-local-hour on Monday), the most recent qualifying
  // Monday is the previous one.
  if (anchor.getTime() > now.getTime()) {
    anchor = new Date(anchor.getTime() - 7 * 86_400_000);
    // Adjust for DST drift by re-resolving from the local date.
    const back = getLocalParts(anchor, tz);
    if (back) {
      const reanchor = utcForLocalDate(back.year, back.month, back.day, hour, tz);
      if (reanchor) anchor = reanchor;
    }
  }
  const deltaMs = now.getTime() - anchor.getTime();
  return deltaMs >= 0 && deltaMs < 86_400_000;
}

async function loadWatchlistEntityIds(env: Env, email: string): Promise<Set<string>> {
  try {
    const r = await env.DB.prepare(
      `SELECT DISTINCT m.entity_id
         FROM watchlist_members m
         JOIN watchlists w ON w.id = m.watchlist_id
        WHERE w.owner_email = ?`,
    ).bind(email).all<{ entity_id: string }>();
    return new Set((r.results ?? []).map((x) => x.entity_id));
  } catch { return new Set(); }
}

async function renderForRecipient(env: Env, memberIds: Set<string>): Promise<string> {
  const since = "datetime('now','-7 day')";
  const ids = [...memberIds];

  // Personalized section query. If no member ids, return [] so the
  // fallback below kicks in. `groups` is the number of times the
  // placeholder list appears in the SQL — binds must repeat once per
  // group or D1 throws a placeholder-count mismatch.
  async function personalized<T>(groups: number, sql: (placeholders: string) => string): Promise<T[]> {
    if (!ids.length) return [];
    const ph = ids.map(() => "?").join(",");
    const binds: string[] = [];
    for (let i = 0; i < groups; i++) binds.push(...ids);
    const r = await env.DB.prepare(sql(ph)).bind(...binds).all<T>();
    return (r.results ?? []) as T[];
  }
  async function fallback<T>(sql: string): Promise<T[]> {
    const r = await env.DB.prepare(sql).all<T>();
    return (r.results ?? []) as T[];
  }

  let deals = await personalized<Deal>(2,
    (ph) => `SELECT id, company_name_raw, company_entity_id, amount_usd, round_name,
                    announcement_date, event_type, source_url
               FROM deal_events
              WHERE datetime(announcement_date) >= ${since}
                AND (company_entity_id IN (${ph})
                     OR id IN (SELECT deal_id FROM deal_participants WHERE investor_entity_id IN (${ph})))
              ORDER BY COALESCE(amount_usd,0) DESC, announcement_date DESC LIMIT 10`);
  if (!deals.length) {
    deals = await fallback<Deal>(
      `SELECT id, company_name_raw, company_entity_id, amount_usd, round_name,
              announcement_date, event_type, source_url
         FROM deal_events
        WHERE datetime(announcement_date) >= ${since}
        ORDER BY COALESCE(amount_usd,0) DESC, announcement_date DESC LIMIT 10`);
  }

  let moves = await personalized<Move>(3,
    (ph) => `SELECT id, person_name_raw, person_entity_id, movement_type, from_firm_entity_id,
                    to_firm_entity_id, to_title, observed_at
               FROM partner_movements
              WHERE status = 'confirmed' AND datetime(observed_at) >= ${since}
                AND (person_entity_id IN (${ph}) OR from_firm_entity_id IN (${ph}) OR to_firm_entity_id IN (${ph}))
              ORDER BY observed_at DESC LIMIT 5`);
  if (!moves.length) {
    moves = await fallback<Move>(
      `SELECT id, person_name_raw, person_entity_id, movement_type, from_firm_entity_id,
              to_firm_entity_id, to_title, observed_at
         FROM partner_movements
        WHERE status = 'confirmed' AND datetime(observed_at) >= ${since}
        ORDER BY observed_at DESC LIMIT 5`);
  }

  let funds = await personalized<Fund>(1,
    (ph) => `SELECT id, fund_name, firm_entity_id, target_size_usd, strategy,
                    fund_status, created_at
               FROM funds
              WHERE (datetime(created_at) >= ${since}
                     OR (fund_status='raising' AND datetime(updated_at) >= ${since}))
                AND firm_entity_id IN (${ph})
              ORDER BY COALESCE(target_size_usd,0) DESC, created_at DESC LIMIT 3`);
  if (!funds.length) {
    funds = await fallback<Fund>(
      `SELECT id, fund_name, firm_entity_id, target_size_usd, strategy,
              fund_status, created_at
         FROM funds
        WHERE datetime(created_at) >= ${since}
           OR (fund_status='raising' AND datetime(updated_at) >= ${since})
        ORDER BY COALESCE(target_size_usd,0) DESC, created_at DESC LIMIT 3`);
  }

  let commits = await personalized<Commit>(2,
    (ph) => `SELECT e.display_name AS lp_name, c.lp_entity_id, c.fund_entity_id,
                    c.fund_name_raw, c.committed_usd, c.vintage_year, c.as_of_date
               FROM lp_fund_commitments c
               LEFT JOIN u_entities e ON e.id = c.lp_entity_id
              WHERE datetime(c.created_at) >= ${since}
                AND (c.lp_entity_id IN (${ph}) OR c.fund_entity_id IN (${ph}))
              ORDER BY c.committed_usd DESC LIMIT 3`);
  if (!commits.length) {
    commits = await fallback<Commit>(
      `SELECT e.display_name AS lp_name, c.lp_entity_id, c.fund_entity_id,
              c.fund_name_raw, c.committed_usd, c.vintage_year, c.as_of_date
         FROM lp_fund_commitments c
         LEFT JOIN u_entities e ON e.id = c.lp_entity_id
        WHERE datetime(c.created_at) >= ${since}
        ORDER BY c.committed_usd DESC LIMIT 3`);
  }

  return renderHtml({ deals, moves, funds, commits, personalized: memberIds.size > 0 });
}

function esc(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);
}
function usd(n: number | null | undefined): string {
  if (!n) return "—";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toLocaleString()}`;
}

function renderHtml(p: {
  deals: Deal[]; moves: Move[]; funds: Fund[]; commits: Commit[]; personalized: boolean;
}): string {
  const dealRows = p.deals.map((d) =>
    `<tr><td>${esc(d.announcement_date ?? "")}</td><td>${esc(d.company_name_raw)}</td><td>${esc(d.round_name ?? d.event_type)}</td><td style="text-align:right">${esc(usd(d.amount_usd))}</td></tr>`).join("");
  const moveRows = p.moves.map((m) =>
    `<tr><td>${esc(m.observed_at)}</td><td>${esc(m.person_name_raw)}</td><td>${esc(m.movement_type)}</td><td>${esc(m.to_title ?? "")}</td></tr>`).join("");
  const fundRows = p.funds.map((f) =>
    `<tr><td>${esc(f.fund_name)}</td><td>${esc(f.strategy ?? "")}</td><td>${esc(f.fund_status)}</td><td style="text-align:right">${esc(usd(f.target_size_usd))}</td></tr>`).join("");
  const commitRows = p.commits.map((c) =>
    `<tr><td>${esc(c.lp_name ?? "")}</td><td>${esc(c.fund_name_raw)}</td><td>${esc(c.vintage_year ?? "")}</td><td style="text-align:right">${esc(usd(c.committed_usd))}</td></tr>`).join("");

  const section = (h: string, headers: string[], body: string, empty: string) => `
    <h3 style="margin:24px 0 8px;color:#e3e6eb">${h}</h3>
    ${body ? `<table style="width:100%;border-collapse:collapse;color:#aab3bf;font-size:13px">
      <thead><tr>${headers.map((x) => `<th style="text-align:left;padding:6px;border-bottom:1px solid #2a2e36">${esc(x)}</th>`).join("")}</tr></thead>
      <tbody>${body}</tbody></table>` : `<div style="color:#6c757d;font-style:italic">${esc(empty)}</div>`}`;

  return `<div style="font-family:-apple-system,sans-serif;background:#16181d;color:#e3e6eb;padding:24px">
    <h2 style="margin:0 0 4px">Last week in your capital-markets watch</h2>
    <div style="color:#6c757d;font-size:12px">Week ending ${new Date().toISOString().slice(0, 10)}${p.personalized ? " · personalized for your watchlists" : " · platform-wide top picks (no watchlist members yet)"}</div>
    ${section("Top 10 deals", ["Date", "Company", "Round", "Amount"], dealRows, "No deals in the last 7 days.")}
    ${section("Top 5 partner movements", ["Date", "Person", "Movement", "Title"], moveRows, "No confirmed movements in the last 7 days.")}
    ${section("Top 3 new funds", ["Fund", "Strategy", "Status", "Target"], fundRows, "No new funds in the last 7 days.")}
    ${section("Top 3 LP commitments", ["LP", "Fund", "Vintage", "Committed"], commitRows, "No disclosed commitments in the last 7 days.")}
  </div>`;
}

// ---------------- tz helpers (mirror monitoring/schedule.ts) ----------------
function clampHour(h: unknown): number {
  const n = Math.floor(Number(h));
  if (!Number.isFinite(n)) return 9;
  return Math.max(0, Math.min(23, n));
}
function getLocalParts(d: Date, tz: string): { year: number; month: number; day: number; hour: number; isoWeekday: number } | null {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", hour12: false, weekday: "short",
    });
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const wmap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };
    const wd = wmap[get("weekday").slice(0, 3)] ?? 0;
    return {
      year: Number(get("year")), month: Number(get("month")), day: Number(get("day")),
      hour: Number(get("hour")), isoWeekday: wd,
    };
  } catch { return null; }
}
function tzOffsetMinutes(d: Date, tz: string): number {
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    const parts = fmt.formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const asUtc = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")),
      Number(get("hour")), Number(get("minute")), Number(get("second")));
    return Math.round((asUtc - d.getTime()) / 60000);
  } catch { return 0; }
}
function utcForLocalDate(year: number, month: number, day: number, hourLocal: number, tz: string): Date | null {
  const tentative = Date.UTC(year, month - 1, day, hourLocal, 0, 0);
  const offsetMin = tzOffsetMinutes(new Date(tentative), tz);
  return new Date(tentative - offsetMin * 60_000);
}
