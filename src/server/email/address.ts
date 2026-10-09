/**
 * Email address helpers. Syntax validity is NOT proof an address exists —
 * these functions only normalise, classify and extract.
 */

const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,24}$/;

export function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let e = raw.trim().toLowerCase().replace(/^mailto:/, "").split("?")[0].replace(/[<>()"',;:\s]+$/g, "").replace(/^[<("'\s]+/, "");
  try {
    e = decodeURIComponent(e);
  } catch {
    /* keep as-is */
  }
  if (e.length > 254) return null;
  const [local, domain] = e.split("@");
  if (!local || !domain || local.length > 64) return null;
  return EMAIL_RE.test(e) ? e : null;
}

export function domainOfEmail(e: string): string {
  return e.split("@")[1] ?? "";
}

const ROLE_LOCALS = new Set([
  "info", "hello", "hi", "contact", "contactus", "enquiries", "enquiry", "inquiries", "inquiry", "bookings", "booking", "book", "appointments",
  "reservations", "admin", "office", "sales", "support", "help", "team", "studio", "salon", "mail", "general", "customercare", "care", "orders",
]);

/** Business enquiry mailbox (info@, bookings@…) — the preferred kind of address for B2B outreach. */
export function isRoleAddress(e: string): boolean {
  return ROLE_LOCALS.has(e.split("@")[0].replace(/[._-]/g, ""));
}

// Free webmail providers: fine for small businesses (many use gmail.com), just not a domain signal.
export const FREE_PROVIDERS = new Set(["gmail.com", "yahoo.com", "yahoo.co.uk", "hotmail.com", "outlook.com", "live.com", "icloud.com", "aol.com", "ymail.com", "proton.me", "protonmail.com", "zoho.com", "mail.com", "gmx.com"]);

// Small built-in list of disposable domains (extend via a provider for full coverage).
const DISPOSABLE = new Set(["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "temp-mail.org", "yopmail.com", "trashmail.com", "sharklasers.com", "getnada.com", "dispostable.com", "maildrop.cc", "fakeinbox.com", "throwawaymail.com", "moakt.com"]);

export function isDisposable(e: string): boolean {
  return DISPOSABLE.has(domainOfEmail(e));
}

// Addresses that appear on websites but aren't the business's contact.
const JUNK_DOMAINS = ["example.com", "example.org", "domain.com", "email.com", "yourdomain.com", "sentry.io", "wixpress.com", "sentry-next.wixpress.com", "godaddy.com", "squarespace.com", "w3.org", "schema.org", "googleusercontent.com", "cloudflare.com", "jquery.com", "wordpress.org", "mysite.com"];
const JUNK_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon|abuse|webmaster|privacy|dpo|legal|careers|jobs|hr|press|media|unsubscribe)$/;
const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?)$/;

export function isJunk(e: string): boolean {
  const [local, domain] = e.split("@");
  if (ASSET_EXT.test(e) || /^[0-9a-f]{16,}$/.test(local)) return true; // hashed tracking ids, image@2x.png
  if (JUNK_LOCAL.test(local)) return true;
  return JUNK_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

export interface FoundEmail {
  email: string;
  how: "mailto" | "text" | "obfuscated";
}

/** Extract candidate addresses from HTML or text, including simple obfuscation ("name [at] domain [dot] com"). */
export function extractEmails(html: string): FoundEmail[] {
  const out = new Map<string, FoundEmail>();
  const add = (raw: string, how: FoundEmail["how"]) => {
    const e = normalizeAddress(raw);
    if (e && !isJunk(e) && !out.has(e)) out.set(e, { email: e, how });
  };
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?#]+)/gi)) add(m[1], "mailto");
  // Cloudflare email protection (data-cfemail) — decode the documented XOR scheme.
  for (const m of html.matchAll(/data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) {
    const hex = m[1];
    const key = parseInt(hex.slice(0, 2), 16);
    let s = "";
    for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    add(s, "obfuscated");
  }
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#64;|&commat;/gi, "@")
    .replace(/&#46;|&period;/gi, ".");
  for (const m of text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,24}/gi)) add(m[0], "text");
  for (const m of text.matchAll(/([a-z0-9._%+-]+)\s*[[(]\s*at\s*[\])]\s*([a-z0-9-]+(?:\s*[[(]\s*dot\s*[\])]\s*[a-z0-9-]+)+)/gi)) {
    add(`${m[1]}@${m[2].replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, ".")}`, "obfuscated");
  }
  return [...out.values()];
}

/** Prefer business-domain role addresses, then any business-domain address, then free-mail. */
export function rankEmails(found: string[], siteDomain: string | null): string[] {
  const score = (e: string) => {
    const d = domainOfEmail(e);
    const sameDomain = siteDomain && (d === siteDomain || siteDomain.endsWith(`.${d}`) || d.endsWith(`.${siteDomain}`));
    return (sameDomain ? 4 : 0) + (isRoleAddress(e) ? 2 : 0) + (FREE_PROVIDERS.has(d) ? 1 : 0);
  };
  return [...found].sort((a, b) => score(b) - score(a));
}
