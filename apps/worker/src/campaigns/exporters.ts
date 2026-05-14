// Per-format CSV/JSON serializers for marketing-tool exports. Each emits a
// schema the destination tool ingests cleanly without errors.

export interface ExportLead {
  id: string;
  name: string | null;
  email: string | null;
  org: string | null;
  title: string | null;
  linkedin_url: string | null;
  twitter_url: string | null;
  city: string | null;
  country_iso2: string | null;
  sector_slug: string | null;
  persona_role: string | null;
}

function csvEscape(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvRows(headers: string[], rows: Record<string, unknown>[]): string {
  const out: string[] = [headers.join(",")];
  for (const r of rows) out.push(headers.map((h) => csvEscape(r[h])).join(","));
  return out.join("\r\n") + "\r\n";
}

function splitName(full: string | null): { first: string; last: string } {
  if (!full) return { first: "", last: "" };
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { first: parts[0], last: "" };
  return { first: parts.slice(0, -1).join(" "), last: parts[parts.length - 1] };
}

/** Lemlist required columns: email, firstName, lastName, companyName, linkedinUrl, picture. */
export function toLemlistCsv(leads: ExportLead[]): string {
  const headers = ["email", "firstName", "lastName", "companyName", "title", "linkedinUrl", "city", "country"];
  const rows = leads
    .filter((l) => l.email)
    .map((l) => {
      const { first, last } = splitName(l.name);
      return {
        email: l.email,
        firstName: first,
        lastName: last,
        companyName: l.org ?? "",
        title: l.title ?? "",
        linkedinUrl: l.linkedin_url ?? "",
        city: l.city ?? "",
        country: l.country_iso2 ?? "",
      };
    });
  return csvRows(headers, rows);
}

/** Instantly: email,first_name,last_name,company_name,personalization */
export function toInstantlyCsv(leads: ExportLead[]): string {
  const headers = ["email", "first_name", "last_name", "company_name", "title", "linkedin_url"];
  const rows = leads
    .filter((l) => l.email)
    .map((l) => {
      const { first, last } = splitName(l.name);
      return {
        email: l.email,
        first_name: first,
        last_name: last,
        company_name: l.org ?? "",
        title: l.title ?? "",
        linkedin_url: l.linkedin_url ?? "",
      };
    });
  return csvRows(headers, rows);
}

/** HubSpot Contacts CSV. */
export function toHubspotCsv(leads: ExportLead[]): string {
  const headers = ["Email", "First Name", "Last Name", "Company Name", "Job Title", "LinkedIn Bio", "City", "Country"];
  const rows = leads.map((l) => {
    const { first, last } = splitName(l.name);
    return {
      "Email": l.email ?? "",
      "First Name": first,
      "Last Name": last,
      "Company Name": l.org ?? "",
      "Job Title": l.title ?? "",
      "LinkedIn Bio": l.linkedin_url ?? "",
      "City": l.city ?? "",
      "Country": l.country_iso2 ?? "",
    };
  });
  return csvRows(headers, rows);
}

/** Generic CSV mirroring the lead shape. */
export function toGenericCsv(leads: ExportLead[]): string {
  const headers = ["id", "name", "email", "org", "title", "linkedin_url", "twitter_url", "city", "country_iso2", "sector_slug", "persona_role"];
  return csvRows(headers, leads as unknown as Record<string, unknown>[]);
}

export function toJson(leads: ExportLead[]): string {
  return JSON.stringify({ count: leads.length, leads }, null, 2);
}

export type ExportFormat = "csv" | "json" | "hubspot" | "lemlist" | "instantly";

export function renderExport(format: ExportFormat, leads: ExportLead[]): { body: string; contentType: string; filename: string } {
  switch (format) {
    case "lemlist": return { body: toLemlistCsv(leads), contentType: "text/csv", filename: "campaign-lemlist.csv" };
    case "instantly": return { body: toInstantlyCsv(leads), contentType: "text/csv", filename: "campaign-instantly.csv" };
    case "hubspot": return { body: toHubspotCsv(leads), contentType: "text/csv", filename: "campaign-hubspot.csv" };
    case "json": return { body: toJson(leads), contentType: "application/json", filename: "campaign.json" };
    case "csv":
    default: return { body: toGenericCsv(leads), contentType: "text/csv", filename: "campaign.csv" };
  }
}
