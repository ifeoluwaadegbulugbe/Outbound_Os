import { coreName, normalizeName } from "./normalize";

/**
 * Entity resolution. Decides whether two prospect records describe the same
 * business, with a confidence score and the reasons behind it.
 *
 * Policy (see docs/architecture.md):
 *  - "merge"   only when a unique identifier (Instagram/TikTok handle, or
 *              phone/email with a compatible name) matches and nothing
 *              conflicts. These are the same account, not a guess.
 *  - "flag"    plausible duplicates (fuzzy name + location, shared domain…)
 *              go to the Possible duplicates review queue. Never merged
 *              without a human.
 *  - "distinct" below the flag threshold.
 */

export interface DedupRecord {
  id?: string;
  business_name: string;
  city: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  website_domain: string | null;
  owner_name?: string | null;
  source_url?: string | null;
}

export interface DedupMatch {
  confidence: number;
  decision: "merge" | "flag" | "distinct";
  reasons: string[];
  conflicts: string[];
}

export const FLAG_THRESHOLD = 50;

// Shared hosting domains are not identity signals.
const GENERIC_DOMAINS = new Set([
  "instagram.com", "tiktok.com", "facebook.com", "linktr.ee", "beacons.ai", "wa.me", "bit.ly", "gmail.com",
  "yahoo.com", "selar.co", "paystack.shop", "bumpa.shop", "stan.store", "calendly.com", "fresha.com", "google.com",
  "business.site", "wixsite.com", "blogspot.com", "carrd.co",
]);

function trigrams(s: string): Set<string> {
  const padded = `  ${s} `;
  const out = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** pg_trgm-compatible similarity (|A∩B| / |A∪B| over word-padded trigrams). */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const words = (s: string) => s.split(" ").filter(Boolean);
  const A = new Set<string>();
  const B = new Set<string>();
  for (const w of words(a)) for (const t of trigrams(w)) A.add(t);
  for (const w of words(b)) for (const t of trigrams(w)) B.add(t);
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const union = A.size + B.size - inter;
  return union === 0 ? 0 : inter / union;
}

/** 1 when every token of the shorter name appears in the longer one. */
export function tokenContainment(a: string, b: string): number {
  const ta = a.split(" ").filter(Boolean);
  const tb = b.split(" ").filter(Boolean);
  if (!ta.length || !tb.length) return 0;
  const [short, long] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return short.filter((t) => long.has(t)).length / short.length;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export function nameSimilarity(a: string, b: string): number {
  // Handles like "nailsbyteni" vs "Nails by Teni".
  if (compact(a) && compact(a) === compact(b)) return 0.97;
  const na = coreName(a) || normalizeName(a);
  const nb = coreName(b) || normalizeName(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // Handles like "nailsbyteni" vs "Nails by Teni": compare with spaces removed.
  const ca = na.replace(/ /g, "");
  const cb = nb.replace(/ /g, "");
  if (ca === cb) return 0.97;
  const tri = trigramSimilarity(na, nb);
  const cont = tokenContainment(na, nb);
  // Containment counts only if the shared part is substantive (≥2 tokens or a long token).
  const shortTokens = Math.min(na.split(" ").length, nb.split(" ").length);
  const contScore = cont === 1 && (shortTokens >= 2 || Math.min(ca.length, cb.length) >= 6) ? 0.88 : cont * 0.6;
  return Math.max(tri, contScore);
}

function eq(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}
function bothDiffer(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.toLowerCase() !== b.toLowerCase());
}

export function compareProspects(a: DedupRecord, b: DedupRecord): DedupMatch {
  const reasons: string[] = [];
  const conflicts: string[] = [];
  const nameSim = nameSimilarity(a.business_name, b.business_name);
  const sameCity = eq(a.city, b.city);
  const diffCity = bothDiffer(a.city, b.city);

  if (bothDiffer(a.instagram_handle, b.instagram_handle)) conflicts.push(`Different Instagram (@${a.instagram_handle} vs @${b.instagram_handle})`);
  if (bothDiffer(a.tiktok_handle, b.tiktok_handle)) conflicts.push(`Different TikTok (@${a.tiktok_handle} vs @${b.tiktok_handle})`);

  const phonesA = new Set([a.phone, a.whatsapp].filter(Boolean) as string[]);
  const phonesB = [b.phone, b.whatsapp].filter(Boolean) as string[];
  const phoneMatch = phonesB.find((p) => phonesA.has(p));

  let strong = 0;
  let strongKind: "handle" | "contact" | null = null;
  if (eq(a.instagram_handle, b.instagram_handle)) {
    strong = 98;
    strongKind = "handle";
    reasons.push(`Same Instagram account @${a.instagram_handle}`);
  }
  if (eq(a.tiktok_handle, b.tiktok_handle)) {
    strong = Math.max(strong, 97);
    strongKind = "handle";
    reasons.push(`Same TikTok account @${a.tiktok_handle}`);
  }
  if (eq(a.source_url, b.source_url)) {
    strong = Math.max(strong, 97);
    strongKind = strongKind ?? "handle";
    reasons.push("Same source URL");
  }
  if (phoneMatch) {
    strong = Math.max(strong, 90);
    strongKind = strongKind ?? "contact";
    reasons.push(`Same phone number ${phoneMatch}`);
  }
  if (eq(a.email, b.email)) {
    strong = Math.max(strong, 92);
    strongKind = strongKind ?? "contact";
    reasons.push(`Same email ${a.email}`);
  }

  const domainMatch = eq(a.website_domain, b.website_domain) && !GENERIC_DOMAINS.has((a.website_domain ?? "").toLowerCase());
  if (domainMatch) reasons.push(`Same website ${a.website_domain}`);

  if (nameSim >= 0.95) reasons.push("Same business name");
  else if (nameSim >= 0.6) reasons.push(`Similar name (${Math.round(nameSim * 100)}% match)`);
  if (sameCity) reasons.push(`Both in ${a.city}`);
  if (diffCity) conflicts.push(`Different cities (${a.city} vs ${b.city})`);
  if (bothDiffer(a.owner_name, b.owner_name) && nameSim < 0.95) conflicts.push("Different owner names");

  let confidence: number;
  if (strong > 0) {
    confidence = strong;
    if (nameSim >= 0.6) confidence = Math.min(99, confidence + 1);
    // Shared contact details with an unrelated name: could be one person running
    // two brands, or a shared number. Needs a human.
    if (strongKind === "contact" && nameSim < 0.4) confidence = Math.min(confidence, 75);
  } else {
    let s = 0;
    if (nameSim >= 0.95) s = 62;
    else if (nameSim >= 0.85) s = 55;
    else if (nameSim >= 0.7) s = 45;
    else if (nameSim >= 0.6) s = 35;
    if (s > 0 && sameCity) s += 12;
    if (domainMatch) s = Math.max(s, 60) + (nameSim >= 0.6 ? 15 : 0);
    confidence = s;
  }
  confidence -= conflicts.length * 25;
  confidence = Math.max(0, Math.min(99, Math.round(confidence)));

  const decision: DedupMatch["decision"] =
    strongKind === "handle" && confidence >= 90 && conflicts.length === 0
      ? "merge"
      : strongKind === "contact" && confidence >= 90 && conflicts.length === 0 && nameSim >= 0.4
        ? "merge"
        : confidence >= FLAG_THRESHOLD
          ? "flag"
          : "distinct";
  return { confidence, decision, reasons, conflicts };
}
