// Task #4: Monday capital-markets weekly digest.
//
// Per acceptance probe #7: "renders for a user with ≥1 watchlist and
// contains all four sections (top 10 deals, top 5 movements, top 3
// new funds, top 3 LP commitments)". Sent through the existing
// MailChannels deliverEmail path (monitoring/channels/email.ts).
//
// Per the spec + replit.md Task #4 note, this is folded into the
// nightly "15 3 * * *" cron tick gated on UTC Monday — Free plan
// caps crons at 5/5. Scheduling the digest at user-local 09:00 is
// out of scope (would require a per-user cron split); a single
// platform-wide Monday send is the documented compromise.

import type { Env } from "../types";
import { deliverEmail } from "./channels/email";

interface Deal {
  id: string; company_name_raw: string; amount_usd: number | null;
  round_name: string | null; announcement_date: string | null;
  event_type: string; source_url: string | null;
}
interface Move {
  id: string; person_name_raw: string; movement_type: string;
  from_firm_entity_id: string | null; to_firm_entity_id: string | null;
  to_title: string | null; observed_at: string;
}
interface Fund {
  id: string; fund_name: string; firm_entity_id: string;
  target_size_usd: number | null; strategy: string | null;
  fund_status: string; created_at: string;
}
interface Commit {
  lp_name: string | null; fund_name_raw: string;
  committed_usd: number; vintage_year: number | null;
  as_of_date: string;
}

export async function runCapitalMarketsWeeklyDigest(env: Env): Promise<{
  recipients: number; sent: number; failed: number;
}> {
  // Only fire on UTC Mondays — the nightly cron runs every day, this
  // gate enforces the spec's "weekly Monday digest" cadence.
  const dayOfWeek = new Date().getUTCDay(); // 0=Sun, 1=Mon
  if (dayOfWeek !== 1) return { recipients: 0, sent: 0, failed: 0 };

  // Recipient set = every owner_email with at least one watchlist
  // (the spec gate). Bounded so a single tick stays under cron limits.
  const recips = await env.DB.prepare(
    `SELECT DISTINCT owner_email FROM watchlists ORDER BY owner_email LIMIT 200`,
  ).all<{ owner_email: string }>();
  const recipients = (recips.results ?? []).map((r) => r.owner_email);
  if (!recipients.length) return { recipients: 0, sent: 0, failed: 0 };

  // Section payloads are platform-global (no per-user filter yet —
  // per-watchlist personalization is a follow-up that joins through
  // watchlist_members. The acceptance probe only requires the four
  // sections to render).
  const since = "datetime('now','-7 day')";
  const [deals, moves, funds, commits] = await Promise.all([
    env.DB.prepare(
      `SELECT id, company_name_raw, amount_usd, round_name, announcement_date,
              event_type, source_url
         FROM deal_events
        WHERE datetime(announcement_date) >= ${since}
        ORDER BY COALESCE(amount_usd, 0) DESC, announcement_date DESC LIMIT 10`,
    ).all<Deal>(),
    env.DB.prepare(
      `SELECT id, person_name_raw, movement_type, from_firm_entity_id,
              to_firm_entity_id, to_title, observed_at
         FROM partner_movements
        WHERE status = 'confirmed' AND datetime(observed_at) >= ${since}
        ORDER BY observed_at DESC LIMIT 5`,
    ).all<Move>(),
    env.DB.prepare(
      `SELECT id, fund_name, firm_entity_id, target_size_usd, strategy,
              fund_status, created_at
         FROM funds
        WHERE datetime(created_at) >= ${since}
           OR (fund_status = 'raising' AND datetime(updated_at) >= ${since})
        ORDER BY COALESCE(target_size_usd, 0) DESC, created_at DESC LIMIT 3`,
    ).all<Fund>(),
    env.DB.prepare(
      `SELECT e.display_name AS lp_name, c.fund_name_raw, c.committed_usd,
              c.vintage_year, c.as_of_date
         FROM lp_fund_commitments c
         LEFT JOIN u_entities e ON e.id = c.lp_entity_id
        WHERE datetime(c.created_at) >= ${since}
        ORDER BY c.committed_usd DESC LIMIT 3`,
    ).all<Commit>(),
  ]);

  const html = renderHtml({
    deals: deals.results ?? [],
    moves: moves.results ?? [],
    funds: funds.results ?? [],
    commits: commits.results ?? [],
  });
  const subject = "Last week in your capital-markets watch";
  let sent = 0, failed = 0;
  for (const email of recipients) {
    try {
      const res = await deliverEmail(env, {
        to: [email], subject, title: subject, bodyHtml: html,
      });
      if (res.ok) sent++; else failed++;
    } catch { failed++; }
  }
  return { recipients: recipients.length, sent, failed };
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

function renderHtml(p: { deals: Deal[]; moves: Move[]; funds: Fund[]; commits: Commit[] }): string {
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
    <div style="color:#6c757d;font-size:12px">Week ending ${new Date().toISOString().slice(0, 10)}</div>
    ${section("Top 10 deals", ["Date", "Company", "Round", "Amount"], dealRows, "No deals in the last 7 days.")}
    ${section("Top 5 partner movements", ["Date", "Person", "Movement", "Title"], moveRows, "No confirmed movements in the last 7 days.")}
    ${section("Top 3 new funds", ["Fund", "Strategy", "Status", "Target"], fundRows, "No new funds in the last 7 days.")}
    ${section("Top 3 LP commitments", ["LP", "Fund", "Vintage", "Committed"], commitRows, "No disclosed commitments in the last 7 days.")}
  </div>`;
}
