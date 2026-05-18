// Task #1: SEC EDGAR Deep Adapter.
//
// Pure HTML/XML extractor following the SiteAdapter contract — no DB
// writes, no network calls. The crawler engine has already fetched the
// page through fetcher.ts (UA = AxalVCBot, per-host throttle via the
// hostThrottle DO, robots-respecting) and archived a copy to R2.
//
// This file dispatches on the URL shape + form type and delegates to a
// per-form parser. Each parser returns a typed payload that the persist
// layer (apps/worker/src/services/secEdgar/persist.ts) writes through
// `insertFact` plus the dedicated sec_* tables defined in migration 349.
//
// Forms handled:
//   - ADV     (Investment Adviser registration)
//   - D       (Reg D private placement)
//   - 13F-HR  (Institutional holdings)
//   - SC 13D / 13G  (Beneficial ownership)
//   - 4              (Insider transactions, §16)
//   - S-1            (IPO registration)
//   - 8-K            (Current report — material events)
//   - 10-K / 10-Q    (Annual / quarterly report)
//   - PF             (Private fund adviser)
//
// Dispatch order: the engine drives a single `extract` call. We sniff the
// form type from URL + page content, then route to the right parser. The
// adapter ALWAYS returns a candidate (even for unknown forms — a thin
// "filing index page" candidate) so the engine never drops EDGAR pages.

import type { SiteAdapter, AdapterResult, AdapterCandidate } from "./types";
import { stripTags, pickTitle, collectLinks } from "./_util";

// ----------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------

const FORM_RE = /\b(10-K|10-Q|8-K|S-1|S-3|S-4|13F-HR|13F-HR\/A|13F|13D|13G|SC\s*13D|SC\s*13G|Form\s*4|Form\s*ADV|Form\s*D|N-PX|N-CSR|Form\s*PF|PF)\b/i;
const CIK_QS_RE  = /(?:CIK|cik)=(\d+)/;
const CIK_PATH_RE = /\/Archives\/edgar\/data\/(\d+)\//i;
const ACC_PATH_RE = /\/Archives\/edgar\/data\/\d+\/(\d{10}-?\d{2}-?\d{6})/i;

export function normalizeAccession(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // EDGAR accession numbers are 18 digits as "XXXXXXXXXX-XX-XXXXXX".
  const digits = raw.replace(/[^0-9]/g, "");
  if (digits.length !== 18) return null;
  return `${digits.slice(0, 10)}-${digits.slice(10, 12)}-${digits.slice(12, 18)}`;
}

export function padCik(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const d = raw.replace(/[^0-9]/g, "");
  if (!d || d.length > 10) return null;
  return d.padStart(10, "0");
}

function parseUsd(s: string | null | undefined): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[,$\s]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? Math.round(n) : null;
}

function parseInt0(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = Number(String(s).replace(/[^0-9-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

function toIsoDate(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  // EDGAR commonly emits MM/DD/YYYY or YYYYMMDD.
  let m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(t);
  if (m) return `${m[3]}-${m[1]}-${m[2]}`;
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null;
}

function detectForm(url: string, html: string, title: string): string | null {
  // `cgi-bin/browse-edgar` URLs are filing-INDEX listings ("show me all
  // 10-K filings for CIK X"), not the filings themselves. The `type=` query
  // param tells EDGAR which list to render; using it as the form hint
  // would mis-route an index page into the 10-K parser. For those URLs,
  // bypass the URL hint and fall through to title/body sniff.
  const isIndexListing = /\/cgi-bin\/browse-edgar/i.test(url);
  if (!isIndexListing) {
    const urlForm = /forms?=([^&]+)/i.exec(url)?.[1];
    if (urlForm) {
      const decoded = decodeURIComponent(urlForm).replace(/\+/g, " ").trim();
      if (decoded) return decoded.toUpperCase();
    }
  }
  const titleForm = FORM_RE.exec(title)?.[1];
  if (titleForm) return titleForm.toUpperCase().replace(/\s+/g, " ").trim();
  const bodyForm = FORM_RE.exec(stripTags(html).slice(0, 4000))?.[1];
  if (bodyForm) return bodyForm.toUpperCase().replace(/\s+/g, " ").trim();
  return null;
}

// ----------------------------------------------------------------------
// Per-form payload shapes
// ----------------------------------------------------------------------

export interface FilingHeader {
  accession_no: string | null;
  cik: string | null;
  form_type: string | null;
  filer_name: string | null;
  filed_at: string | null;
  period_of_report: string | null;
  filing_url: string;
  primary_doc_url: string | null;
}

export interface AdvFund {
  fund_name: string;
  fund_id_807: string | null;
  fund_type: string | null;
  gross_asset_value: number | null;
  beneficial_owners: number | null;
  minimum_investment: number | null;
  master_feeder: string | null;
  custodian: string | null;
  auditor: string | null;
  prime_broker: string | null;
  state_country: string | null;
}

export interface AdvPayload {
  adviser_crd: string | null;
  adviser_sec_no: string | null;
  adviser_name: string;
  total_aum_usd: number | null;
  employee_count: number | null;
  hq_city: string | null;
  hq_country: string | null;
  website: string | null;
  control_persons: Array<{ name: string; title: string | null; ownership_pct: number | null }>;
  funds: AdvFund[];
}

export interface FormDPayload {
  issuer_cik: string | null;
  issuer_name: string;
  issuer_jurisdiction: string | null;
  issuer_year_of_inc: number | null;
  industry_group: string | null;
  entity_type: string | null;
  total_offering_amount: number | null;
  total_amount_sold: number | null;
  total_remaining: number | null;
  minimum_investment: number | null;
  total_investors: number | null;
  date_of_first_sale: string | null;
  exemption_claimed: string | null;
  related_persons: Array<{ name: string; role: string | null; address: string | null }>;
  is_amendment: boolean;
}

export interface F13Holding {
  cusip: string;
  issuer_name: string | null;
  title_of_class: string | null;
  value_usd: number | null;
  shares_or_principal: number | null;
  share_type: string | null;
  put_call: string | null;
  investment_discretion: string | null;
  voting_sole: number | null;
  voting_shared: number | null;
  voting_none: number | null;
}

export interface Form13FPayload {
  filer_cik: string | null;
  filer_name: string | null;
  period_of_report: string | null;
  total_value_usd: number;
  holdings: F13Holding[];
}

export interface BeneficialOwner {
  reporting_owner_cik: string | null;
  reporting_owner_name: string;
  issuer_cik: string | null;
  issuer_name: string | null;
  shares_owned: number | null;
  percent_of_class: number | null;
  date_of_event: string | null;
  purpose: string | null;
}

export interface Form4Trade {
  reporting_owner_cik: string | null;
  reporting_owner_name: string;
  issuer_cik: string | null;
  issuer_name: string | null;
  issuer_ticker: string | null;
  is_director: boolean;
  is_officer: boolean;
  is_ten_percent_owner: boolean;
  is_other: boolean;
  officer_title: string | null;
  transaction_date: string | null;
  transaction_code: string | null;
  shares: number | null;
  price_per_share: number | null;
  shares_after: number | null;
  ownership_form: string | null;
}

export interface FormS1Payload {
  issuer_name: string;
  issuer_cik: string | null;
  underwriters: string[];
  proposed_max_offering_usd: number | null;
  ticker_symbol: string | null;
}

export interface Form8KItem {
  item_number: string;
  item_title: string | null;
  summary: string | null;
}

export interface Form8KPayload {
  issuer_name: string;
  issuer_cik: string | null;
  items: Form8KItem[];
  event_date: string | null;
}

export interface Form10KExecutive {
  name: string;
  title: string | null;
  total_compensation_usd: number | null;
}

export interface Form10KPayload {
  issuer_name: string;
  issuer_cik: string | null;
  fiscal_year_end: string | null;
  revenue_usd: number | null;
  net_income_usd: number | null;
  total_assets_usd: number | null;
  executives: Form10KExecutive[];
}

export interface FormPFFund {
  fund_name: string;
  fund_id_807: string | null;
  gross_asset_value: number | null;
  net_asset_value: number | null;
  fund_type: string | null;
}

export interface FormPFPayload {
  adviser_name: string;
  adviser_crd: string | null;
  total_regulatory_aum_usd: number | null;
  funds: FormPFFund[];
}

export type ParsedFiling =
  | { kind: "adv";    header: FilingHeader; data: AdvPayload }
  | { kind: "form_d"; header: FilingHeader; data: FormDPayload }
  | { kind: "13f";    header: FilingHeader; data: Form13FPayload }
  | { kind: "13d";    header: FilingHeader; data: BeneficialOwner }
  | { kind: "form4";  header: FilingHeader; data: Form4Trade }
  | { kind: "s1";     header: FilingHeader; data: FormS1Payload }
  | { kind: "8k";     header: FilingHeader; data: Form8KPayload }
  | { kind: "10k";    header: FilingHeader; data: Form10KPayload }
  | { kind: "10q";    header: FilingHeader; data: Form10KPayload }
  | { kind: "pf";     header: FilingHeader; data: FormPFPayload }
  | { kind: "index";  header: FilingHeader; data: { filings: Array<{ form: string; date: string | null; href: string | null; accession_no: string | null }> } };

// ----------------------------------------------------------------------
// Per-form parsers — each is a PURE function over (html, url, header).
// They MUST tolerate noisy input and return a partially-populated payload
// on parse failure; a thrown error in any parser is swallowed by the
// dispatcher and treated as a low-confidence index candidate.
// ----------------------------------------------------------------------

function extractHeader(html: string, url: string): FilingHeader {
  const accession_no =
    normalizeAccession(ACC_PATH_RE.exec(url)?.[1])
    ?? normalizeAccession(html.match(/SEC\s*Accession\s*No\.?[:\s]*([\d\-]{18,20})/i)?.[1])
    ?? normalizeAccession(html.match(/accessionNumber["']?\s*[:=]\s*["']?([\d\-]{18,20})/i)?.[1])
    ?? null;
  const cik = padCik(CIK_QS_RE.exec(url)?.[1] ?? CIK_PATH_RE.exec(url)?.[1] ?? html.match(/CIK\s*[:=]?\s*(\d{1,10})/i)?.[1]);
  const filer_name =
    html.match(/<span class="companyName">\s*([^<&]+?)\s*</i)?.[1]?.trim()
    ?? html.match(/Filer\s*<\/[^>]+>\s*<[^>]+>\s*([^<]+)/i)?.[1]?.trim()
    ?? null;
  const filed_at = toIsoDate(
    html.match(/Filed[:\s]+(\d{4}-\d{2}-\d{2})/i)?.[1]
    ?? html.match(/Filing\s*Date[^<]*<[^>]+>\s*([^<]+)</i)?.[1]
    ?? html.match(/Accepted[^<]*<[^>]+>\s*([^<]+)</i)?.[1]
    ?? null,
  );
  const period_of_report = toIsoDate(
    html.match(/Period of Report[^<]*<[^>]+>\s*([^<]+)</i)?.[1]
    ?? html.match(/Period:\s*<[^>]+>\s*([^<]+)</i)?.[1]
    ?? null,
  );
  const primary = html.match(/<a[^>]+href=["']([^"']+\.(?:htm|html|xml|txt))["'][^>]*>\s*Primary\s*Document/i)?.[1] ?? null;
  return {
    accession_no, cik, form_type: null,
    filer_name, filed_at, period_of_report,
    filing_url: url,
    primary_doc_url: primary ? resolveUrl(primary, url) : null,
  };
}

function resolveUrl(href: string, base: string): string {
  try { return new URL(href, base).toString(); } catch { return href; }
}

export function parseFormADV(html: string, _url: string, header: FilingHeader): AdvPayload {
  const text = stripTags(html);
  const adviser_crd = html.match(/CRD\s*Number[^0-9]{0,40}(\d{4,9})/i)?.[1] ?? text.match(/CRD\s*#?\s*[:\.]?\s*(\d{4,9})/i)?.[1] ?? null;
  const adviser_sec_no = text.match(/SEC\s*(?:File\s*)?(?:Number|No\.?)[:\s]*(801-\d+)/i)?.[1] ?? null;
  const adviser_name =
    html.match(/<(?:h1|h2)[^>]*>\s*([^<]+?)\s*<\/(?:h1|h2)>/i)?.[1]?.trim()
    ?? header.filer_name
    ?? "Unknown Adviser";
  const total_aum_usd = parseUsd(
    text.match(/Regulatory\s*Assets\s*[Uu]nder\s*[Mm]anagement[^$0-9]{0,40}\$?([\d,]+)/i)?.[1]
    ?? text.match(/Total\s*Assets\s*[Uu]nder\s*[Mm]anagement[^$0-9]{0,40}\$?([\d,]+)/i)?.[1]
    ?? text.match(/AUM[^$0-9]{0,20}\$?([\d,]+)/i)?.[1]
    ?? null,
  );
  const employee_count = parseInt0(text.match(/Total\s*Number\s*of\s*Employees[^0-9]{0,40}([\d,]+)/i)?.[1] ?? null);
  const hq_city = text.match(/Principal\s*Office[^A-Za-z]{0,40}([A-Z][A-Za-z .'-]+?),\s*[A-Z]{2}/i)?.[1]?.trim() ?? null;
  const hq_country = text.match(/Country[:\s]+([A-Z][A-Za-z ]{2,40})/i)?.[1]?.trim() ?? null;
  // Two layouts: "Website: <a>https://…</a>"  (label-before-link) and
  // "<a href='https://…'>Website</a>" (link-with-label-inside). Try both.
  const website =
    html.match(/(?:Website|Web\s*Site)[:\s]*<a[^>]+href=["'](https?:\/\/[^"']+)["']/i)?.[1]
    ?? html.match(/<a[^>]+href=["'](https?:\/\/[^"']+)["'][^>]*>\s*(?:Website|Web\s*Site)/i)?.[1]
    ?? null;

  // Schedule D Section 7.B.(1): private-fund table. Each row is one fund.
  // Heuristic: rows with a Fund ID (807-XXXXXXXX) anchor the parse.
  const funds: AdvFund[] = [];
  const fundIdRe = /(807-\d{8})/g;
  let m: RegExpExecArray | null;
  const seenFundIds = new Set<string>();
  while ((m = fundIdRe.exec(html))) {
    const id = m[1];
    if (seenFundIds.has(id)) continue;
    seenFundIds.add(id);
    // Capture a ~1200 char window around the fund-id for field extraction.
    const start = Math.max(0, m.index - 600);
    const window = html.slice(start, m.index + 600);
    const windowText = stripTags(window);
    const fund_name =
      window.match(/<td[^>]*>\s*([A-Z][^<]{2,120}?(?:Fund|Partners|Capital|Ventures|LP|L\.P\.|LLC)[^<]*?)\s*</i)?.[1]?.trim()
      ?? windowText.match(/Name\s*of\s*(?:Private\s*)?Fund[:\s]+([^|]+?)(?:\s{2,}|$)/i)?.[1]?.trim()
      ?? `Fund ${id}`;
    const fund_type = (windowText.match(/\b(hedge fund|private equity fund|venture capital fund|real estate fund|liquidity fund|securitized asset fund)\b/i)?.[1] ?? null)
      ?.toLowerCase().replace(/\s+/g, "_") ?? null;
    funds.push({
      fund_name: fund_name.slice(0, 200),
      fund_id_807: id,
      fund_type,
      gross_asset_value: parseUsd(windowText.match(/Gross\s*Asset\s*Value[^$0-9]{0,30}\$?([\d,]+)/i)?.[1] ?? null),
      beneficial_owners: parseInt0(windowText.match(/Beneficial\s*Owners[^0-9]{0,30}([\d,]+)/i)?.[1] ?? null),
      minimum_investment: parseUsd(windowText.match(/Minimum\s*Investment[^$0-9]{0,30}\$?([\d,]+)/i)?.[1] ?? null),
      master_feeder: windowText.match(/\b(Master|Feeder)\b/i)?.[1]?.toLowerCase() ?? null,
      custodian: windowText.match(/Custodian[:\s]+([A-Z][A-Za-z0-9 .,'&-]{2,80})/i)?.[1]?.trim() ?? null,
      auditor: windowText.match(/Auditor[:\s]+([A-Z][A-Za-z0-9 .,'&-]{2,80})/i)?.[1]?.trim() ?? null,
      prime_broker: windowText.match(/Prime\s*Broker[:\s]+([A-Z][A-Za-z0-9 .,'&-]{2,80})/i)?.[1]?.trim() ?? null,
      state_country: windowText.match(/State or Country[:\s]+([A-Z][A-Za-z ]{2,40})/i)?.[1]?.trim() ?? null,
    });
    if (funds.length >= 200) break;
  }

  // Control persons / GPs — Schedule A/B. Rows with "Title or Status" column.
  const control_persons: AdvPayload["control_persons"] = [];
  const personRowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let pm: RegExpExecArray | null;
  while ((pm = personRowRe.exec(html))) {
    const rowText = stripTags(pm[1]);
    const pmatch = /^([A-Z][A-Z .'-]+?,\s*[A-Z][A-Za-z .'-]+?)\s+(CEO|CFO|COO|GP|MANAGING\s*(?:MEMBER|PARTNER|DIRECTOR)|PARTNER|PRESIDENT|CHAIRMAN|DIRECTOR|MEMBER|MANAGER)\b/i.exec(rowText);
    if (!pmatch) continue;
    const pctMatch = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(rowText);
    control_persons.push({
      name: pmatch[1].trim(),
      title: pmatch[2].trim().toUpperCase(),
      ownership_pct: pctMatch ? Number(pctMatch[1]) : null,
    });
    if (control_persons.length >= 50) break;
  }

  return {
    adviser_crd, adviser_sec_no, adviser_name,
    total_aum_usd, employee_count, hq_city, hq_country, website,
    control_persons, funds,
  };
}

export function parseFormD(html: string, _url: string, header: FilingHeader): FormDPayload {
  const text = stripTags(html);
  // Issuer name extraction. Prefer the explicit "Entity Name of Issuer"
  // label (in either HTML-tagged or plain-text rendering), then the
  // <span class="companyName"> (EDGAR's stock header), and only fall
  // back to <h1>/<h2> if the heading isn't a generic Schedule section
  // header ("Related Persons", "Schedule A", etc.).
  const headingFallback = ((): string | null => {
    const m = /<(?:h1|h2)[^>]*>\s*([^<]+?)\s*<\/(?:h1|h2)>/i.exec(html);
    if (!m) return null;
    const t = m[1].trim();
    if (/^(Related\s+Persons|Schedule\s+[A-Z]|Direct\s+Owners|Form\s+\w+)/i.test(t)) return null;
    return t;
  })();
  const issuer_name =
    html.match(/Entity\s*Name\s*of\s*Issuer[^A-Za-z0-9]{0,30}<[^>]+>\s*([^<]+)</i)?.[1]?.trim()
    ?? text.match(/Entity\s*Name\s*of\s*Issuer[:\s]+([A-Z][A-Z0-9 .,&'-]{2,120}?)(?:\s{2,}|$)/m)?.[1]?.trim()
    ?? html.match(/<span class="companyName">\s*([^<&]+?)\s*</i)?.[1]?.trim()
    ?? headingFallback
    ?? header.filer_name
    ?? "Unknown Issuer";
  // Capture jurisdiction as a single all-caps token-run; stop at any
  // mixed-case word boundary (e.g. "Year of Incorporation") so we don't
  // bleed into the next label.
  const issuer_jurisdiction =
    text.match(/Jurisdiction\s*of\s*Incorporation[:\s]+([A-Z]{2,}(?:\s+[A-Z]{2,})*)/)?.[1]?.trim() ?? null;
  const issuer_year_of_inc = parseInt0(text.match(/Year\s*of\s*Incorporation[:\s]+(\d{4})/i)?.[1] ?? null);
  const industry_group = text.match(/Industry\s*Group[:\s]+([A-Z][A-Za-z ,&-]+?)(?:\s{2,}|Revenue|$)/i)?.[1]?.trim() ?? null;
  const entity_type = text.match(/Entity\s*Type[:\s]+([A-Z][A-Za-z .]+?)(?:\s{2,}|Jurisdiction|$)/i)?.[1]?.trim() ?? null;
  const total_offering_amount = parseUsd(text.match(/Total\s*Offering\s*Amount[^$0-9]{0,30}\$?([\d,]+)/i)?.[1] ?? null);
  const total_amount_sold = parseUsd(text.match(/Total\s*Amount\s*Sold[^$0-9]{0,30}\$?([\d,]+)/i)?.[1] ?? null);
  const total_remaining = parseUsd(text.match(/Total\s*Remaining[^$0-9]{0,30}\$?([\d,]+)/i)?.[1] ?? null);
  const minimum_investment = parseUsd(text.match(/Minimum\s*Investment[^$0-9]{0,30}\$?([\d,]+)/i)?.[1] ?? null);
  const total_investors = parseInt0(text.match(/Total\s*Number\s*of\s*(?:Already\s*)?Investors[^0-9]{0,30}([\d,]+)/i)?.[1] ?? null);
  const date_of_first_sale = toIsoDate(text.match(/Date\s*of\s*First\s*Sale[:\s]+(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i)?.[1] ?? null);
  const exemption_claimed = text.match(/(?:Exemption|Rule)\s*(?:Claimed)?[:\s]+(506\(b\)|506\(c\)|504|4\(a\)\(5\))/i)?.[1] ?? null;
  const is_amendment = /Amendment/i.test(header.form_type || "") || /Is\s*this\s*offering\s*an\s*amendment.*?Yes/is.test(html);

  const related_persons: FormDPayload["related_persons"] = [];
  // "Related Persons" table — rows of (name, relationship, address).
  const relRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm: RegExpExecArray | null;
  let inRelatedBlock = /Related\s*Persons/i.test(html);
  while (inRelatedBlock && (rm = relRe.exec(html))) {
    const t = stripTags(rm[1]);
    const pm = /^([A-Z][A-Z .'-]+?,\s*[A-Z][A-Za-z .'-]+?)\s+(Executive Officer|Director|Promoter|Manager|Member|Partner|Officer)\b/i.exec(t);
    if (!pm) continue;
    related_persons.push({
      name: pm[1].trim(),
      role: pm[2].trim(),
      address: t.match(/(\d+\s+[A-Z][A-Za-z .,'-]+,\s+[A-Z][A-Za-z .]+,\s+[A-Z]{2}\s+\d{5})/)?.[1] ?? null,
    });
    if (related_persons.length >= 25) break;
  }

  return {
    issuer_cik: header.cik,
    issuer_name,
    issuer_jurisdiction,
    issuer_year_of_inc,
    industry_group,
    entity_type,
    total_offering_amount,
    total_amount_sold,
    total_remaining,
    minimum_investment,
    total_investors,
    date_of_first_sale,
    exemption_claimed,
    related_persons,
    is_amendment,
  };
}

export function parseForm13F(html: string, _url: string, header: FilingHeader): Form13FPayload {
  // 13F-HR holdings live in XML (information table). We accept either the
  // raw XML or an HTML rendition of it. Both formats include rows of
  // <nameOfIssuer>…</nameOfIssuer><titleOfClass>…<cusip>…<value>…
  const holdings: F13Holding[] = [];
  const blockRe = /<(?:infoTable|tr)\b[\s\S]*?<\/(?:infoTable|tr)>/gi;
  let bm: RegExpExecArray | null;
  let total = 0;
  while ((bm = blockRe.exec(html))) {
    const block = bm[0];
    const cusip = block.match(/<cusip>\s*([A-Z0-9]{6,9})\s*<\/cusip>/i)?.[1]
      ?? block.match(/\b([0-9A-Z]{9})\b/)?.[1];
    if (!cusip) continue;
    const value_raw = block.match(/<value>\s*([\d,]+)\s*<\/value>/i)?.[1]
      ?? block.match(/<td[^>]*>\s*\$?([\d,]+)\s*<\/td>/i)?.[1]
      ?? null;
    // 13F XML reports value in $1000s.
    const valueK = parseInt0(value_raw);
    const value_usd = valueK != null ? valueK * 1000 : null;
    const shares = parseInt0(block.match(/<sshPrnamt>\s*([\d,]+)\s*<\/sshPrnamt>/i)?.[1] ?? null);
    const issuer_name = block.match(/<nameOfIssuer>\s*([^<]+?)\s*<\/nameOfIssuer>/i)?.[1]?.trim() ?? null;
    const title_of_class = block.match(/<titleOfClass>\s*([^<]+?)\s*<\/titleOfClass>/i)?.[1]?.trim() ?? null;
    const share_type = block.match(/<sshPrnamtType>\s*(SH|PRN)\s*<\/sshPrnamtType>/i)?.[1] ?? "SH";
    const put_call = block.match(/<putCall>\s*(PUT|CALL)\s*<\/putCall>/i)?.[1] ?? null;
    const investment_discretion = block.match(/<investmentDiscretion>\s*(SOLE|DFND|OTR)\s*<\/investmentDiscretion>/i)?.[1] ?? null;
    holdings.push({
      cusip, issuer_name, title_of_class, value_usd,
      shares_or_principal: shares,
      share_type, put_call, investment_discretion,
      voting_sole: parseInt0(block.match(/<Sole>\s*([\d,]+)\s*<\/Sole>/i)?.[1] ?? null),
      voting_shared: parseInt0(block.match(/<Shared>\s*([\d,]+)\s*<\/Shared>/i)?.[1] ?? null),
      voting_none: parseInt0(block.match(/<None>\s*([\d,]+)\s*<\/None>/i)?.[1] ?? null),
    });
    if (value_usd) total += value_usd;
    if (holdings.length >= 5000) break;
  }
  return {
    filer_cik: header.cik,
    filer_name: header.filer_name,
    period_of_report: header.period_of_report,
    total_value_usd: total,
    holdings,
  };
}

export function parseSchedule13(html: string, _url: string, header: FilingHeader): BeneficialOwner {
  const text = stripTags(html);
  const reporting_owner_name =
    html.match(/Name\s*of\s*Reporting\s*Person[^A-Za-z0-9]{0,30}<[^>]+>\s*([^<]+)</i)?.[1]?.trim()
    ?? text.match(/Name\s*of\s*Reporting\s*Person[s]?[:\s]+([A-Z][A-Za-z0-9 .,'&-]{2,100})/i)?.[1]?.trim()
    ?? header.filer_name ?? "Unknown Reporter";
  const issuer_name =
    html.match(/Name\s*of\s*Issuer[^A-Za-z0-9]{0,30}<[^>]+>\s*([^<]+)</i)?.[1]?.trim()
    ?? text.match(/Name\s*of\s*Issuer[:\s]+([A-Z][A-Za-z0-9 .,'&-]{2,100})/i)?.[1]?.trim()
    ?? null;
  const shares_owned = parseInt0(text.match(/Aggregate\s*Amount\s*Beneficially\s*Owned[^0-9]{0,40}([\d,]+)/i)?.[1] ?? null);
  const percent_of_class = Number(text.match(/Percent\s*of\s*Class[^0-9]{0,40}([\d.]+)\s*%/i)?.[1] ?? "") || null;
  const date_of_event = toIsoDate(text.match(/Date\s*of\s*Event[^0-9]{0,30}(\d{2}\/\d{2}\/\d{4}|\d{4}-\d{2}-\d{2})/i)?.[1] ?? null);
  const purpose = text.match(/Purpose\s*of\s*Transaction[:\s]+([A-Z][A-Za-z0-9 .,'&-]{10,400})/i)?.[1]?.trim().slice(0, 400) ?? null;
  return {
    reporting_owner_cik: null,
    reporting_owner_name,
    issuer_cik: null,
    issuer_name,
    shares_owned,
    percent_of_class,
    date_of_event,
    purpose,
  };
}

export function parseForm4(html: string, _url: string, header: FilingHeader): Form4Trade {
  // Form 4 ships an XML document at primary_doc.xml; HTML render mirrors fields.
  const reporting_owner_name = html.match(/<rptOwnerName>\s*([^<]+?)\s*<\/rptOwnerName>/i)?.[1]?.trim()
    ?? html.match(/Reporting\s*Person[^<]*<[^>]+>\s*([^<]+)</i)?.[1]?.trim()
    ?? header.filer_name ?? "Unknown Insider";
  const reporting_owner_cik = padCik(html.match(/<rptOwnerCik>\s*(\d{1,10})\s*<\/rptOwnerCik>/i)?.[1] ?? null);
  const issuer_name = html.match(/<issuerName>\s*([^<]+?)\s*<\/issuerName>/i)?.[1]?.trim() ?? null;
  const issuer_cik = padCik(html.match(/<issuerCik>\s*(\d{1,10})\s*<\/issuerCik>/i)?.[1] ?? null);
  const issuer_ticker = html.match(/<issuerTradingSymbol>\s*([A-Z.]{1,8})\s*<\/issuerTradingSymbol>/i)?.[1] ?? null;
  const is_director = /<isDirector>\s*(?:true|1)\s*<\/isDirector>/i.test(html);
  const is_officer = /<isOfficer>\s*(?:true|1)\s*<\/isOfficer>/i.test(html);
  const is_ten_percent_owner = /<isTenPercentOwner>\s*(?:true|1)\s*<\/isTenPercentOwner>/i.test(html);
  const is_other = /<isOther>\s*(?:true|1)\s*<\/isOther>/i.test(html);
  const officer_title = html.match(/<officerTitle>\s*([^<]+?)\s*<\/officerTitle>/i)?.[1]?.trim() ?? null;
  const transaction_date = toIsoDate(
    html.match(/<transactionDate>[\s\S]*?<value>\s*(\d{4}-\d{2}-\d{2})\s*<\/value>/i)?.[1] ?? null,
  );
  const transaction_code = html.match(/<transactionCode>\s*([A-Z])\s*<\/transactionCode>/i)?.[1] ?? null;
  const shares = Number(html.match(/<transactionShares>[\s\S]*?<value>\s*([\d.]+)\s*<\/value>/i)?.[1] ?? "") || null;
  const price_per_share = Number(html.match(/<transactionPricePerShare>[\s\S]*?<value>\s*([\d.]+)\s*<\/value>/i)?.[1] ?? "") || null;
  const shares_after = Number(html.match(/<sharesOwnedFollowingTransaction>[\s\S]*?<value>\s*([\d.]+)\s*<\/value>/i)?.[1] ?? "") || null;
  const ownership_form = html.match(/<directOrIndirectOwnership>[\s\S]*?<value>\s*([DI])\s*<\/value>/i)?.[1] ?? null;
  return {
    reporting_owner_cik, reporting_owner_name,
    issuer_cik, issuer_name, issuer_ticker,
    is_director, is_officer, is_ten_percent_owner, is_other,
    officer_title,
    transaction_date, transaction_code, shares, price_per_share, shares_after, ownership_form,
  };
}

export function parseFormS1(html: string, _url: string, header: FilingHeader): FormS1Payload {
  const text = stripTags(html);
  const issuer_name =
    html.match(/<(?:h1|h2)[^>]*>\s*([^<]+?)\s*<\/(?:h1|h2)>/i)?.[1]?.trim()
    ?? header.filer_name ?? "Unknown Issuer";
  const underwriters: string[] = [];
  const uwBlock = text.match(/Underwriter[s]?[\s\S]{0,2000}/i)?.[0] ?? "";
  const uwRe = /\b((?:Goldman|Morgan Stanley|J\.?P\.? Morgan|Citigroup|Bank of America|Merrill Lynch|Credit Suisse|Barclays|Deutsche Bank|Wells Fargo|UBS|RBC|Jefferies|Cowen|Piper Sandler|William Blair|Stifel|Allen & Company)[A-Za-z &.]*)/g;
  let um: RegExpExecArray | null;
  while ((um = uwRe.exec(uwBlock))) {
    const u = um[1].trim();
    if (!underwriters.includes(u)) underwriters.push(u);
    if (underwriters.length >= 20) break;
  }
  const proposed_max_offering_usd = parseUsd(
    text.match(/Proposed\s*Maximum\s*Aggregate\s*Offering\s*Price[^$0-9]{0,40}\$?([\d,]+)/i)?.[1] ?? null,
  );
  const ticker_symbol = text.match(/(?:Trading\s*Symbol|Ticker)[:\s]+([A-Z]{1,5})\b/)?.[1] ?? null;
  return { issuer_name, issuer_cik: header.cik, underwriters, proposed_max_offering_usd, ticker_symbol };
}

const FORM_8K_ITEMS: Record<string, string> = {
  "1.01": "Entry into a Material Definitive Agreement",
  "1.02": "Termination of a Material Definitive Agreement",
  "1.03": "Bankruptcy or Receivership",
  "2.01": "Completion of Acquisition or Disposition of Assets",
  "2.02": "Results of Operations and Financial Condition",
  "2.03": "Creation of a Material Direct Financial Obligation",
  "3.02": "Unregistered Sales of Equity Securities",
  "5.02": "Departure/Election of Directors or Officers",
  "7.01": "Regulation FD Disclosure",
  "8.01": "Other Events",
};

export function parseForm8K(html: string, _url: string, header: FilingHeader): Form8KPayload {
  const text = stripTags(html);
  const items: Form8KItem[] = [];
  const itemRe = /Item\s+(\d\.\d{2})\s*\.?\s*([A-Z][A-Za-z ,/&'-]{4,120})/g;
  let im: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((im = itemRe.exec(text))) {
    const num = im[1];
    if (seen.has(num)) continue;
    seen.add(num);
    items.push({
      item_number: num,
      item_title: FORM_8K_ITEMS[num] ?? im[2].trim().slice(0, 120),
      summary: text.slice(im.index, im.index + 400).replace(/\s+/g, " ").trim(),
    });
    if (items.length >= 15) break;
  }
  return {
    issuer_name: header.filer_name ?? "Unknown",
    issuer_cik: header.cik,
    items,
    event_date: header.period_of_report ?? header.filed_at,
  };
}

export function parseForm10K(html: string, _url: string, header: FilingHeader): Form10KPayload {
  const text = stripTags(html);
  const revenue_usd = parseUsd(
    text.match(/Total\s*(?:Net\s*)?(?:R|r)evenues?[^$0-9]{0,40}\$?([\d,]+)/)?.[1] ?? null,
  );
  const net_income_usd = parseUsd(
    text.match(/Net\s*(?:I|i)ncome(?:\s*\(loss\))?[^$0-9]{0,40}\$?([\d,]+)/)?.[1] ?? null,
  );
  const total_assets_usd = parseUsd(
    text.match(/Total\s*(?:A|a)ssets[^$0-9]{0,40}\$?([\d,]+)/)?.[1] ?? null,
  );
  const fiscal_year_end = toIsoDate(
    text.match(/Fiscal\s*Year\s*End(?:ed|ing)?[:\s]+([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{4}-\d{2}-\d{2})/)?.[1] ?? null,
  ) ?? header.period_of_report;
  const executives: Form10KExecutive[] = [];
  const execRe = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s+(Chief\s+\w+\s+Officer|President|CEO|CFO|COO|CTO|Chairman|Director)\s+[^$]*?\$([\d,]+)/g;
  let em: RegExpExecArray | null;
  while ((em = execRe.exec(text))) {
    executives.push({ name: em[1], title: em[2], total_compensation_usd: parseUsd(em[3]) });
    if (executives.length >= 10) break;
  }
  return {
    issuer_name: header.filer_name ?? "Unknown",
    issuer_cik: header.cik,
    fiscal_year_end,
    revenue_usd, net_income_usd, total_assets_usd,
    executives,
  };
}

export function parseFormPF(html: string, _url: string, header: FilingHeader): FormPFPayload {
  const text = stripTags(html);
  const adviser_name = header.filer_name ?? html.match(/<(?:h1|h2)[^>]*>\s*([^<]+?)\s*<\/(?:h1|h2)>/i)?.[1]?.trim() ?? "Unknown Adviser";
  const adviser_crd = text.match(/CRD\s*#?\s*[:\.]?\s*(\d{4,9})/i)?.[1] ?? null;
  const total_regulatory_aum_usd = parseUsd(
    text.match(/(?:Total\s*)?Regulatory\s*Assets\s*[Uu]nder\s*[Mm]anagement[^$0-9]{0,40}\$?([\d,]+)/)?.[1] ?? null,
  );
  const funds: FormPFFund[] = [];
  const fundIdRe = /(807-\d{8})/g;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = fundIdRe.exec(html))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    const start = Math.max(0, m.index - 400);
    const window = stripTags(html.slice(start, m.index + 600));
    funds.push({
      fund_name: window.match(/(?:Fund|Vehicle)\s*[Nn]ame[:\s]+([A-Z][A-Za-z0-9 .,'&-]+?)(?:\s{2,}|$)/)?.[1]?.trim() ?? `Fund ${m[1]}`,
      fund_id_807: m[1],
      gross_asset_value: parseUsd(window.match(/Gross\s*Asset\s*Value[^$0-9]{0,30}\$?([\d,]+)/i)?.[1] ?? null),
      net_asset_value: parseUsd(window.match(/Net\s*Asset\s*Value[^$0-9]{0,30}\$?([\d,]+)/i)?.[1] ?? null),
      fund_type: window.match(/\b(hedge fund|private equity fund|venture capital fund|liquidity fund|real estate fund)\b/i)?.[1]?.toLowerCase().replace(/\s+/g, "_") ?? null,
    });
    if (funds.length >= 200) break;
  }
  return { adviser_name, adviser_crd, total_regulatory_aum_usd, funds };
}

// ----------------------------------------------------------------------
// Dispatcher: pick the right parser based on form + URL, wrap result in
// the SiteAdapter contract.
// ----------------------------------------------------------------------

function classifyForm(form: string | null): ParsedFiling["kind"] | "index" {
  if (!form) return "index";
  const f = form.toUpperCase().replace(/\s+/g, " ");
  if (/^FORM\s*ADV\b|^ADV\b/.test(f)) return "adv";
  if (/^FORM\s*D\b|^D\b/.test(f)) return "form_d";
  if (/^13F/.test(f)) return "13f";
  if (/^(SC\s*)?13[DG]/.test(f)) return "13d";
  if (/^FORM\s*4\b|^4\b/.test(f)) return "form4";
  if (/^S-1\b|^S-3\b|^S-4\b/.test(f)) return "s1";
  if (/^8-K\b/.test(f)) return "8k";
  if (/^10-K\b/.test(f)) return "10k";
  if (/^10-Q\b/.test(f)) return "10q";
  if (/^FORM\s*PF\b|^PF\b/.test(f)) return "pf";
  return "index";
}

function parseIndexPage(html: string, _url: string, header: FilingHeader) {
  const filings: Array<{ form: string; date: string | null; href: string | null; accession_no: string | null }> = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let row: RegExpExecArray | null;
  while ((row = rowRe.exec(html))) {
    const rowHtml = row[1];
    const fM = FORM_RE.exec(stripTags(rowHtml));
    if (!fM) continue;
    const date = stripTags(rowHtml).match(/\b(20\d{2}-\d{2}-\d{2}|19\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null;
    const href = rowHtml.match(/<a\s+[^>]*href=["']([^"']+)["']/i)?.[1] ?? null;
    filings.push({
      form: fM[1].toUpperCase().replace(/\s+/g, ""),
      date, href,
      accession_no: normalizeAccession(href ? ACC_PATH_RE.exec(href)?.[1] ?? null : null),
    });
    if (filings.length >= 50) break;
  }
  return { kind: "index" as const, header, data: { filings } };
}

/**
 * Parse a SEC EDGAR page into a typed ParsedFiling. Exported for the
 * persist layer (services/secEdgar/persist.ts) to consume.
 */
export function parseEdgarPage(html: string, url: string): ParsedFiling {
  const title = pickTitle(html);
  const header = extractHeader(html, url);
  const form = detectForm(url, html, title);
  header.form_type = form;
  // `cgi-bin/browse-edgar` URLs are always filing-index listings — even
  // when the body mentions specific form types in the rendered table.
  // Force the index parser so we extract the per-filing row table.
  const kind: ParsedFiling["kind"] = /\/cgi-bin\/browse-edgar/i.test(url)
    ? "index"
    : classifyForm(form);

  try {
    switch (kind) {
      case "adv":    return { kind: "adv",    header, data: parseFormADV(html, url, header) };
      case "form_d": return { kind: "form_d", header, data: parseFormD(html, url, header) };
      case "13f":    return { kind: "13f",    header, data: parseForm13F(html, url, header) };
      case "13d":    return { kind: "13d",    header, data: parseSchedule13(html, url, header) };
      case "form4":  return { kind: "form4",  header, data: parseForm4(html, url, header) };
      case "s1":     return { kind: "s1",     header, data: parseFormS1(html, url, header) };
      case "8k":     return { kind: "8k",     header, data: parseForm8K(html, url, header) };
      case "10k":    return { kind: "10k",    header, data: parseForm10K(html, url, header) };
      case "10q":    return { kind: "10q",    header, data: parseForm10K(html, url, header) };
      case "pf":     return { kind: "pf",     header, data: parseFormPF(html, url, header) };
      default:       return parseIndexPage(html, url, header);
    }
  } catch (e) {
    // Per the adapter contract: parsers must never throw out of the
    // dispatcher. Degrade to the index parse so the page is at least
    // crawled and we surface child filing URLs for the frontier.
    console.warn("secEdgar parser failed", kind, (e as Error).message);
    return parseIndexPage(html, url, header);
  }
}

// ----------------------------------------------------------------------
// SiteAdapter export
// ----------------------------------------------------------------------

export const secEdgar: SiteAdapter = {
  id: "sec_edgar",
  priority: 88,
  hosts: ["sec.gov", "www.sec.gov", "efts.sec.gov", "adviserinfo.sec.gov"],
  url_patterns: [
    /\/cgi-bin\/browse-edgar/i,
    /\/Archives\/edgar\/data\//i,
    /\/cgi-bin\/srqsb/i,
    /\/edgar\/searchedgar\//i,
    /\/efts\.sec\.gov/i,
    /\/firm\/summary\//i,
  ],
  profile_types_emitted: ["public_company", "investor_vc", "investor_pe", "investor_pension", "fund_of_funds"],
  extract(html, url): AdapterResult {
    const parsed = parseEdgarPage(html, url);

    // Pick a profile_type hint that downstream workflows can route on.
    const profileType = ((): string | null => {
      switch (parsed.kind) {
        case "adv":
        case "pf":
        case "13f":    return "investor_vc"; // narrowed by xref layer if PE/pension
        case "13d":    return "investor_vc";
        case "form_d": return null; // issuer; xref decides company vs firm
        case "form4":  return "public_company";
        case "s1":
        case "8k":
        case "10k":
        case "10q":    return "public_company";
        default:       return null;
      }
    })();

    // Display name: form-specific.
    const displayName = ((): string | null => {
      switch (parsed.kind) {
        case "adv":    return parsed.data.adviser_name;
        case "pf":     return parsed.data.adviser_name;
        case "form_d": return parsed.data.issuer_name;
        case "13f":    return parsed.data.filer_name;
        case "13d":    return parsed.data.reporting_owner_name;
        case "form4":  return parsed.data.reporting_owner_name;
        case "s1":     return parsed.data.issuer_name;
        case "8k":
        case "10k":
        case "10q":    return parsed.data.issuer_name;
        default:       return parsed.header.filer_name;
      }
    })();

    // Confidence: high when we have a CIK+form match, medium for index pages.
    const confidence = parsed.kind === "index"
      ? (parsed.header.cik ? 0.5 : 0.3)
      : (parsed.header.accession_no ? 0.9 : 0.75);

    // Back-compat shape for the existing secEdgar.test.mjs fixture (index page):
    // it asserts on `data.cik`, `data.registrant_name`, `data.filings[]`.
    const legacyShape = parsed.kind === "index" ? {
      registrant_name: parsed.header.filer_name,
      cik: parsed.header.cik,
      form: parsed.header.form_type,
      filings: parsed.data.filings,
      filing_count: parsed.data.filings.length,
      edgar_url: url,
    } : {};

    const candidate: AdapterCandidate = {
      profile_type: profileType,
      confidence,
      name: displayName ?? parsed.header.filer_name,
      url,
      data: {
        ...legacyShape,
        accession_no: parsed.header.accession_no,
        cik: parsed.header.cik,
        form: parsed.header.form_type,
        registrant_name: displayName ?? parsed.header.filer_name,
        edgar_url: url,
        parsed_kind: parsed.kind,
        parsed,
      },
    };

    // Surface child filing URLs (the engine doesn't auto-enqueue; the
    // smart_frontier drainer + persist layer handle that).
    const child = collectLinks(html, url)
      .filter((u) => /\/Archives\/edgar\/data\//i.test(u) || /\/cgi-bin\/browse-edgar/i.test(u))
      .slice(0, 50);

    return {
      adapter_id: "sec_edgar",
      confidence,
      candidates: [candidate],
      child_urls: child,
    };
  },
};
