// Canonical key generators for the unified entity model. Channels are
// keyed by (kind, canonical) and equality must collapse trivial
// presentation differences — case, whitespace, '+suffix' in emails,
// formatting characters in phone numbers, query strings on LinkedIn URLs.
export function canonicalEmail(raw) {
    if (!raw)
        return null;
    const s = String(raw).trim().toLowerCase();
    const m = /^([^@\s]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(s);
    if (!m)
        return null;
    // Strip '+suffix' from the local part (Gmail-style).
    const local = m[1].split("+")[0];
    return `${local}@${m[2]}`;
}
export function canonicalPhone(raw) {
    if (!raw)
        return null;
    const digits = String(raw).replace(/[^\d+]/g, "");
    if (!digits)
        return null;
    // Best-effort E.164: keep leading + if present, else assume already
    // includes country code.
    return digits.startsWith("+") ? digits : `+${digits.replace(/^\++/, "")}`;
}
export function canonicalLinkedin(raw) {
    if (!raw)
        return null;
    let s = String(raw).trim();
    if (!s)
        return null;
    // Accept handle-only ("janedoe") or full URL.
    if (!/^https?:\/\//i.test(s) && !s.includes("/")) {
        return `/in/${s.toLowerCase()}`;
    }
    try {
        const u = new URL(s.startsWith("http") ? s : `https://${s}`);
        if (!/linkedin\.com$/i.test(u.hostname) && !/(^|\.)linkedin\.com$/i.test(u.hostname))
            return null;
        const p = u.pathname.replace(/\/+$/, "").toLowerCase();
        // /in/<slug> | /company/<slug> | /school/<slug>
        const m = /^\/(in|company|school|pub)\/([^/?#]+)/.exec(p);
        if (!m)
            return null;
        return `/${m[1] === "pub" ? "in" : m[1]}/${m[2]}`;
    }
    catch {
        return null;
    }
}
export function canonicalTwitter(raw) {
    if (!raw)
        return null;
    const s = String(raw).trim().replace(/^@/, "");
    if (!s)
        return null;
    if (/^https?:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            const m = /^\/([A-Za-z0-9_]{1,15})\/?$/.exec(u.pathname);
            return m ? m[1].toLowerCase() : null;
        }
        catch {
            return null;
        }
    }
    return /^[A-Za-z0-9_]{1,15}$/.test(s) ? s.toLowerCase() : null;
}
export function canonicalGithub(raw) {
    if (!raw)
        return null;
    const s = String(raw).trim().replace(/^@/, "");
    if (!s)
        return null;
    if (/^https?:\/\//i.test(s)) {
        try {
            const u = new URL(s);
            const m = /^\/([A-Za-z0-9-]{1,39})\/?$/.exec(u.pathname);
            return m ? m[1].toLowerCase() : null;
        }
        catch {
            return null;
        }
    }
    return /^[A-Za-z0-9-]{1,39}$/.test(s) ? s.toLowerCase() : null;
}
export function canonicalDomain(raw) {
    if (!raw)
        return null;
    let s = String(raw).trim().toLowerCase();
    if (!s)
        return null;
    if (/^https?:\/\//.test(s)) {
        try {
            s = new URL(s).hostname;
        }
        catch {
            return null;
        }
    }
    s = s.replace(/^www\./, "").replace(/\/.*$/, "");
    return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}
export function canonicalUrl(raw) {
    if (!raw)
        return null;
    try {
        const u = new URL(String(raw).trim());
        u.hash = "";
        return u.toString();
    }
    catch {
        return null;
    }
}
export async function sha256(s) {
    const buf = new TextEncoder().encode(s);
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
