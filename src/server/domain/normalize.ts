import { parsePhoneNumberFromString } from "libphonenumber-js/min";
import { CATEGORIES, findCity, type CategoryKey } from "./taxonomy";

/**
 * Normalization + signal extraction. Every extracted value records *where*
 * it came from so later AI/brief layers can cite it as a known fact.
 */

const NAME_STOPWORDS = new Set([
  "the", "and", "&", "ltd", "limited", "enterprise", "enterprises", "ventures", "nig", "nigeria", "ng",
  "official", "co", "company", "inc", "services", "service", "hub", "by",
]);
const CITY_WORDS = new Set(["lagos", "abuja", "ph", "portharcourt", "ibadan", "benin", "kano", "enugu", "lekki", "ikeja", "vi"]);

/** Lowercase, strip punctuation/emojis, drop legal suffixes. Used for dedup. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[_.\-|/]+/g, " ")
    .replace(/[^a-z0-9 &]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !NAME_STOPWORDS.has(w))
    .join(" ")
    .trim();
}

/** Name without location words — "Joy Beauty Lagos" ≈ "Joy Beauty". */
export function coreName(name: string): string {
  return normalizeName(name)
    .split(" ")
    .filter((w) => !CITY_WORDS.has(w))
    .join(" ");
}

export function normalizePhone(raw: string | null | undefined, defaultCountry: string = "NG"): string | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, "");
  if (cleaned.replace(/\D/g, "").length < 7) return null;
  const p = parsePhoneNumberFromString(cleaned, (defaultCountry || "NG").toUpperCase() as Parameters<typeof parsePhoneNumberFromString>[1]);
  if (!p || !p.isPossible()) return null;
  return p.number; // E.164
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/.test(e) ? e : null;
}

export function normalizeHandle(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Instagram/TikTok usernames can't end with a period; trailing dots are punctuation.
  const h = raw.trim().replace(/^@+/, "").replace(/\/+$/, "").replace(/\.+$/, "").toLowerCase();
  return /^[a-z0-9._]{1,30}$/.test(h) ? h : null;
}

export function domainOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export function normalizeUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = url.trim();
  if (!s) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (!u.hostname.includes(".")) return null;
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return null;
  }
}

const SOCIAL_HOSTS: Record<string, "instagram" | "tiktok" | "facebook" | "linkedin" | "youtube" | "x"> = {
  "instagram.com": "instagram",
  "instagr.am": "instagram",
  "tiktok.com": "tiktok",
  "facebook.com": "facebook",
  "fb.com": "facebook",
  "linkedin.com": "linkedin",
  "youtube.com": "youtube",
  "youtu.be": "youtube",
  "x.com": "x",
  "twitter.com": "x",
};

const BOOKING_HOSTS = [
  "calendly.com", "fresha.com", "booksy.com", "setmore.com", "squareup.com", "square.site", "acuityscheduling.com",
  "bookafy.com", "vagaro.com", "getorbitcrm.com", "selar.co", "paystack.shop", "paystack.com", "flutterwave.com",
  "bumpa.shop", "linktr.ee", "beacons.ai", "stan.store", "wa.me", "bit.ly", "tidycal.com", "zcal.co", "simplybook.me",
];
const PAYMENT_HOSTS = ["paystack.shop", "paystack.com", "flutterwave.com", "selar.co", "stan.store", "bumpa.shop"];
const SCHEDULING_HOSTS = ["calendly.com", "fresha.com", "booksy.com", "setmore.com", "acuityscheduling.com", "vagaro.com", "tidycal.com", "zcal.co", "simplybook.me", "bookafy.com", "square.site"];

/**
 * Profiles that belong to platforms and site builders, not to the business
 * whose website links them (footers often link WhatsApp, Wix, Fresha…).
 */
export const PLATFORM_HANDLES = new Set([
  "whatsapp", "instagram", "facebook", "meta", "tiktok", "fresha", "wix", "wordpressdotcom", "wordpress", "squarespace", "shopify",
  "godaddy", "yahoonews", "yahoo", "google", "youtube", "teepublic", "audiomack", "spotify", "linktree", "beacons", "selar", "paystack",
  "flutterwave", "bumpa", "calendly", "booksy", "jumianigeria", "jumiangr", "jumia", "quicket_za", "lekkeslaap", "ancora_themes", "axiom_themes",
  "themeforest", "envato", "elementor", "canva", "mailchimp",
]);

export function socialFromUrl(url: string): { platform: string; handle: string | null; url: string } | null {
  const domain = domainOf(url);
  if (!domain) return null;
  const host = Object.keys(SOCIAL_HOSTS).find((h) => domain === h || domain.endsWith(`.${h}`));
  if (!host) return null;
  const platform = SOCIAL_HOSTS[host];
  let handle: string | null = null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const parts = u.pathname.split("/").filter(Boolean);
    if (platform === "tiktok") handle = parts[0]?.startsWith("@") ? normalizeHandle(parts[0]) : null;
    else if (platform === "instagram") {
      const first = parts[0];
      if (first && !["p", "reel", "reels", "explore", "stories", "tv", "accounts", "direct", "invites", "about", "legal", "developer", "web"].includes(first)) handle = normalizeHandle(first);
    } else if (platform === "linkedin") handle = parts[1] ?? null;
    else handle = parts[0] ? normalizeHandle(parts[0].replace(/^@/, "")) : null;
  } catch {
    /* ignore */
  }
  return { platform, handle, url: normalizeUrl(url) ?? url };
}

export interface Evidence<T> {
  value: T;
  /** Where it was found: 'bio', 'snippet', 'website', 'name', 'csv:<column>', ... */
  source: string;
  /** Exact text fragment that supports it, when available. */
  quote?: string;
}

export interface ExtractedSignals {
  phones: Evidence<string>[];
  emails: Evidence<string>[];
  urls: Evidence<string>[];
  instagram: Evidence<string>[];
  tiktok: Evidence<string>[];
  mentions: Evidence<string>[];
  bookingUrl: Evidence<string> | null;
  category: Evidence<CategoryKey> | null;
  city: Evidence<string> | null;
  services: Evidence<string>[];
  acceptsBookings: Evidence<boolean> | null;
  whatsappBookings: Evidence<boolean> | null;
  dmBookings: Evidence<boolean> | null;
  onlinePayments: Evidence<boolean> | null;
  manualPayments: Evidence<boolean> | null;
  schedulingTool: Evidence<string> | null;
}

const RE_URL = /\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ng|co|io|me|ee|ai|store|shop|site|app|net|org|link|bio|page|biz|info)(?:\/[^\s,)]*)?)/gi;
const RE_EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const RE_PHONE = /(?:\+?234[\s-]?|0)[789][01]\d[\s-]?\d{3}[\s-]?\d{4}/g;
const RE_MENTION = /(?:^|[^a-z0-9_.@])@([a-z0-9._]{2,30})/gi;

function snippetAround(text: string, idx: number, len: number): string {
  const s = Math.max(0, idx - 30);
  const e = Math.min(text.length, idx + len + 30);
  return (s > 0 ? "…" : "") + text.slice(s, e).trim() + (e < text.length ? "…" : "");
}

function findPhrase(text: string, phrases: string[]): { phrase: string; quote: string } | null {
  const lower = text.toLowerCase();
  for (const p of phrases) {
    const i = lower.indexOf(p);
    if (i >= 0) return { phrase: p, quote: snippetAround(text, i, p.length) };
  }
  return null;
}

const BOOKING_PHRASES = ["dm to book", "dm for booking", "dm for bookings", "book now", "bookings open", "booking open", "to book", "book an appointment", "book appointment", "book via", "book through", "book here", "bookings:", "booking:", "slots available", "slots open", "appointment only", "appointments only", "by appointment", "home service", "home services available", "taking bookings", "now booking", "click the link to book", "link in bio to book", "booking link"];
const WHATSAPP_PHRASES = ["whatsapp", "whats app", "watsapp", "wa.me", "chat on wa", "wa:", "wa -", "📲"];
const DM_PHRASES = ["dm to book", "dm for booking", "dm for bookings", "send a dm", "dm for enquiries", "dm for inquiries", "dm for price", "dm for prices", "dm us", "dm me"];
const MANUAL_PAYMENT_PHRASES = ["account number", "acct no", "acc no", "transfer to", "pay to", "deposit required", "deposit to secure", "50% deposit", "deposit before", "payment before", "no deposit no booking"];
const ONLINE_PAYMENT_PHRASES = ["pay online", "paystack", "flutterwave", "selar", "pay via link", "payment link"];

/** Extract structured, cited signals from free text (bio, snippet, description). */
export function extractSignals(text: string | null | undefined, source: string, extraUrls: string[] = []): ExtractedSignals {
  const t = (text ?? "").replace(/ /g, " ");
  const out: ExtractedSignals = {
    phones: [], emails: [], urls: [], instagram: [], tiktok: [], mentions: [], bookingUrl: null, category: null,
    city: null, services: [], acceptsBookings: null, whatsappBookings: null, dmBookings: null, onlinePayments: null,
    manualPayments: null, schedulingTool: null,
  };

  for (const m of t.matchAll(RE_EMAIL)) {
    const e = normalizeEmail(m[0]);
    if (e && !out.emails.some((x) => x.value === e)) out.emails.push({ value: e, source, quote: m[0] });
  }
  for (const m of t.matchAll(RE_PHONE)) {
    const p = normalizePhone(m[0]);
    if (p && !out.phones.some((x) => x.value === p)) out.phones.push({ value: p, source, quote: snippetAround(t, m.index ?? 0, m[0].length) });
  }
  const textNoEmails = t.replace(RE_EMAIL, " ");
  const urls = [...[...textNoEmails.matchAll(RE_URL)].map((m) => m[1]), ...extraUrls];
  for (const raw of urls) {
    const u = normalizeUrl(raw);
    if (!u || out.urls.some((x) => x.value === u)) continue;
    out.urls.push({ value: u, source, quote: raw });
    const social = socialFromUrl(u);
    if (social?.platform === "instagram" && social.handle) out.instagram.push({ value: social.handle, source, quote: raw });
    if (social?.platform === "tiktok" && social.handle) out.tiktok.push({ value: social.handle, source, quote: raw });
    const d = domainOf(u) ?? "";
    if (d === "wa.me" || d === "api.whatsapp.com") {
      const num = normalizePhone(u.replace(/.*wa\.me\//, "").replace(/\?.*/, "").replace(/.*phone=/, ""));
      if (num && !out.phones.some((x) => x.value === num)) out.phones.push({ value: num, source, quote: raw });
      out.whatsappBookings ??= { value: true, source, quote: raw };
    }
    if (!out.bookingUrl && BOOKING_HOSTS.some((h) => d === h || d.endsWith(`.${h}`)) && d !== "wa.me") {
      out.bookingUrl = { value: u, source, quote: raw };
    }
    const sched = SCHEDULING_HOSTS.find((h) => d === h || d.endsWith(`.${h}`));
    if (sched && !out.schedulingTool) out.schedulingTool = { value: sched, source, quote: raw };
    if (PAYMENT_HOSTS.some((h) => d === h || d.endsWith(`.${h}`))) out.onlinePayments ??= { value: true, source, quote: raw };
  }
  for (const m of t.matchAll(RE_MENTION)) {
    const h = normalizeHandle(m[1]);
    if (h && !h.endsWith(".") && !out.mentions.some((x) => x.value === h)) out.mentions.push({ value: h, source, quote: `@${m[1]}` });
  }
  // "IG: handle" / "TikTok: @handle"
  const igLabel = /\b(?:ig|insta|instagram)\s*[:\-–]\s*@?([a-z0-9._]{2,30})/i.exec(t);
  if (igLabel) {
    const h = normalizeHandle(igLabel[1]);
    if (h && !out.instagram.some((x) => x.value === h)) out.instagram.push({ value: h, source, quote: igLabel[0] });
  }
  const ttLabel = /\b(?:tiktok|tik tok|tt)\s*[:\-–]\s*@?([a-z0-9._]{2,30})/i.exec(t);
  if (ttLabel) {
    const h = normalizeHandle(ttLabel[1]);
    if (h && !out.tiktok.some((x) => x.value === h)) out.tiktok.push({ value: h, source, quote: ttLabel[0] });
  }

  const lower = ` ${t.toLowerCase()} `;
  // Category: count keyword hits, pick the best (ties -> first in taxonomy order).
  let best: { key: CategoryKey; hits: number; quote: string } | null = null;
  for (const c of CATEGORIES) {
    let hits = 0;
    let quote = "";
    for (const k of c.keywords) {
      const re = new RegExp(`(^|[^a-z])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z]|$)`, "i");
      const m = re.exec(lower);
      if (m) {
        hits += k.includes(" ") ? 2 : 1;
        if (!quote) quote = snippetAround(t, Math.max(0, (m.index ?? 0) - 1), k.length);
        if (!out.services.some((s) => s.value === k) && k.length > 3) out.services.push({ value: k, source, quote: k });
      }
    }
    if (hits > 0 && (!best || hits > best.hits)) best = { key: c.key, hits, quote };
  }
  if (best) out.category = { value: best.key, source, quote: best.quote };

  const city = findCity(t);
  if (city) out.city = { value: city.name, source, quote: city.name };

  const booking = findPhrase(t, BOOKING_PHRASES);
  if (booking || out.bookingUrl) out.acceptsBookings = { value: true, source, quote: booking?.quote ?? out.bookingUrl?.quote };
  const wa = findPhrase(t, WHATSAPP_PHRASES);
  if (wa && (booking || /book|order|enquir|inquir|appointment|chat/i.test(t))) out.whatsappBookings ??= { value: true, source, quote: wa.quote };
  const dm = findPhrase(t, DM_PHRASES);
  if (dm) out.dmBookings = { value: true, source, quote: dm.quote };
  const manual = findPhrase(t, MANUAL_PAYMENT_PHRASES);
  if (manual) out.manualPayments = { value: true, source, quote: manual.quote };
  const online = findPhrase(t, ONLINE_PAYMENT_PHRASES);
  if (online) out.onlinePayments ??= { value: true, source, quote: online.quote };

  return out;
}
