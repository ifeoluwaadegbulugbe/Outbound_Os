import { categoryGroup, categoryLabel, NIGERIAN_CITIES } from "./taxonomy";

/**
 * Transparent, deterministic prospect scoring. No LLM involved: every point
 * awarded comes with a human-readable reason, so a user can always see WHY a
 * prospect scored what it did.
 */

export const SCORER_VERSION = "icp-v1";

export interface SignalEvidence {
  value: unknown;
  source: string;
  quote?: string;
}

/** The subset of prospect fields the scorers read. */
export interface ScorableProspect {
  business_name: string;
  category: string | null;
  services: string[];
  country: string | null;
  city: string | null;
  business_size: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  facebook_url?: string | null;
  linkedin_url?: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  website: string | null;
  booking_url: string | null;
  bio: string | null;
  description: string | null;
  follower_count: number | null;
  last_post_date: Date | string | null;
  posting_frequency: number | null;
  accepts_bookings: boolean | null;
  has_booking_link: boolean | null;
  accepts_whatsapp_bookings: boolean | null;
  accepts_online_payments: boolean | null;
  has_website: boolean | null;
  has_client_management_system: boolean | null;
  has_invoice_system: boolean | null;
  has_payment_system: boolean | null;
  signals: Record<string, SignalEvidence>;
}

export interface IcpConfig {
  targetCategories: string[];
  targetCities: string[];       // city names, e.g. "Lagos"
  targetCountry: string;        // ISO-2
  minFollowers: number;
  qualifyThreshold: number;     // icp_score >= this => QUALIFIED
}

export const DEFAULT_ICP: IcpConfig = {
  targetCategories: ["hair_stylist", "barber", "nail_technician", "lash_technician", "makeup_artist", "skincare", "spa_wellness", "photographer", "event_planner", "fashion_designer", "coach", "fitness_trainer"],
  targetCities: NIGERIAN_CITIES.slice(0, 5).map((c) => c.name),
  targetCountry: "NG",
  minFollowers: 500,
  qualifyThreshold: 60,
};

export interface ScoreReason {
  component: ScoreComponent;
  points: number;
  label: string;
  /** 'positive' adds points, 'negative' subtracts, 'missing' explains a gap. */
  kind: "positive" | "negative" | "missing";
}

export type ScoreComponent = "business" | "category" | "geography" | "operational" | "digital" | "pain" | "activity" | "penalty";

export const COMPONENT_MAX: Record<Exclude<ScoreComponent, "penalty">, number> = {
  business: 15,
  category: 20,
  geography: 15,
  operational: 15,
  digital: 10,
  pain: 15,
  activity: 10,
};

export const COMPONENT_LABELS: Record<ScoreComponent, string> = {
  business: "Business fit",
  category: "Category fit",
  geography: "Geography fit",
  operational: "Operational fit",
  digital: "Digital maturity",
  pain: "Pain signals",
  activity: "Activity",
  penalty: "Adjustments",
};

export interface IcpResult {
  icp: number;
  fit: number;      // business + category + geography, 0–100
  intent: number;   // operational + pain + activity, 0–100
  components: Record<ScoreComponent, number>;
  reasons: ScoreReason[];
  qualified: boolean;
}

function sig(p: ScorableProspect, key: string): boolean {
  return p.signals?.[key]?.value === true;
}

export function daysSince(d: Date | string | null | undefined, now = new Date()): number | null {
  if (!d) return null;
  const t = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(t.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - t.getTime()) / 86_400_000));
}

export function scoreIcp(p: ScorableProspect, cfg: IcpConfig = DEFAULT_ICP, now = new Date()): IcpResult {
  const reasons: ScoreReason[] = [];
  const comp: Record<ScoreComponent, number> = { business: 0, category: 0, geography: 0, operational: 0, digital: 0, pain: 0, activity: 0, penalty: 0 };
  const add = (component: ScoreComponent, points: number, label: string) => {
    comp[component] += points;
    reasons.push({ component, points, label, kind: points >= 0 ? "positive" : "negative" });
  };
  const missing = (component: ScoreComponent, label: string) => reasons.push({ component, points: 0, label, kind: "missing" });

  // ── Business fit ──
  if (p.category && p.category !== "other_service") add("business", 15, `Service business (${categoryLabel(p.category)})`);
  else if (p.category === "other_service") add("business", 8, "Service business, category unclear");
  else missing("business", "Business type unknown");

  // ── Category fit ──
  if (p.category && cfg.targetCategories.includes(p.category)) add("category", 20, `${categoryLabel(p.category)} is a target category`);
  else if (p.category && cfg.targetCategories.some((c) => categoryGroup(c) === categoryGroup(p.category))) add("category", 10, `Related to target categories (${categoryGroup(p.category)})`);
  else if (p.category) missing("category", `${categoryLabel(p.category)} is not a target category`);

  // ── Geography ──
  const city = p.city?.trim();
  const inCity = city && cfg.targetCities.some((c) => c.toLowerCase() === city.toLowerCase());
  if (inCity) add("geography", 15, `Based in ${city}`);
  else if ((p.country ?? "").toUpperCase() === cfg.targetCountry && city) add("geography", 9, `In ${city}, outside target cities`);
  else if ((p.country ?? "").toUpperCase() === cfg.targetCountry) add("geography", 6, "In target country, city unknown");
  else if (p.country && p.country.toUpperCase() !== cfg.targetCountry) missing("geography", `Outside target market (${p.country})`);
  else missing("geography", "Location unknown");

  // ── Operational fit: does it run appointments/clients/payments? ──
  if (p.accepts_bookings || sig(p, "acceptsBookings")) add("operational", 6, "Takes bookings");
  if ((p.services?.length ?? 0) >= 2) add("operational", 3, `Offers multiple services (${p.services.slice(0, 3).join(", ")})`);
  if (sig(p, "manualPayments") || p.accepts_online_payments || sig(p, "onlinePayments")) add("operational", 3, "Collects payments from clients");
  if (p.accepts_whatsapp_bookings || sig(p, "whatsappBookings") || sig(p, "dmBookings")) add("operational", 3, "Handles client conversations directly");
  if (comp.operational === 0) missing("operational", "No booking/payment signals found yet");

  // ── Digital maturity ──
  const socials = [p.instagram_handle && "Instagram", p.tiktok_handle && "TikTok", p.facebook_url && "Facebook"].filter(Boolean) as string[];
  if (socials.length) add("digital", Math.min(4, socials.length * 2 + 1), `Active on ${socials.join(" + ")}`);
  if ((p.follower_count ?? 0) >= cfg.minFollowers) add("digital", 3, `${formatCount(p.follower_count!)} followers`);
  else if (p.follower_count != null) missing("digital", `Small audience (${formatCount(p.follower_count)} followers)`);
  if (p.booking_url || p.has_booking_link || p.website || p.has_website) add("digital", 3, p.booking_url ? "Has a booking link" : "Has a website");
  comp.digital = Math.min(comp.digital, COMPONENT_MAX.digital);

  // ── Pain signals: friction Orbit removes ──
  if (sig(p, "dmBookings")) add("pain", 5, "Bookings happen in DMs");
  if (p.accepts_whatsapp_bookings || sig(p, "whatsappBookings")) add("pain", 5, "Bookings via WhatsApp");
  if (sig(p, "manualPayments")) add("pain", 3, "Manual payment instructions (transfers/deposits)");
  const hasText = Boolean(p.bio || p.description);
  if (hasText && !p.has_client_management_system && !p.signals?.schedulingTool && comp.pain > 0) add("pain", 2, "No booking software detected");
  comp.pain = Math.min(comp.pain, COMPONENT_MAX.pain);
  if (comp.pain === 0) missing("pain", hasText ? "No clear manual-workflow signals" : "No bio/description to analyse");

  // ── Activity ──
  const days = daysSince(p.last_post_date, now);
  if (days === null) missing("activity", "Posting activity unknown");
  else if (days <= 14) add("activity", 8, `Posted ${days === 0 ? "today" : `${days}d ago`}`);
  else if (days <= 30) add("activity", 5, `Posted ${days}d ago`);
  else if (days <= 90) add("activity", 2, `Last post ${days}d ago`);
  else missing("activity", `Inactive — last post ${days}d ago`);
  if ((p.posting_frequency ?? 0) >= 3) add("activity", 2, `Posts ~${Math.round(p.posting_frequency!)}×/week`);
  comp.activity = Math.min(comp.activity, COMPONENT_MAX.activity);

  // ── Adjustments ──
  if (p.has_client_management_system || p.signals?.schedulingTool) {
    const tool = p.signals?.schedulingTool?.value;
    add("penalty", -10, `Already uses booking software${typeof tool === "string" ? ` (${tool})` : ""}`);
  }
  if (p.business_size === "large") add("penalty", -8, "Large business — less likely to need Orbit");
  if (days !== null && days > 180) add("penalty", -10, "Possibly closed or dormant");

  const raw = Object.values(comp).reduce((a, b) => a + b, 0);
  const icp = clamp(Math.round(raw));
  const fit = clamp(Math.round(((comp.business + comp.category + comp.geography) / (COMPONENT_MAX.business + COMPONENT_MAX.category + COMPONENT_MAX.geography)) * 100));
  const intent = clamp(Math.round(((comp.operational + comp.pain + comp.activity) / (COMPONENT_MAX.operational + COMPONENT_MAX.pain + COMPONENT_MAX.activity)) * 100));
  return { icp, fit, intent, components: comp, reasons, qualified: icp >= cfg.qualifyThreshold };
}

// ── Data completeness ──────────────────────────────────────────────────────
export interface CompletenessResult {
  score: number;
  present: string[];
  missing: string[];
}

const COMPLETENESS_FIELDS: { label: string; weight: number; has: (p: ScorableProspect) => boolean }[] = [
  { label: "Business name", weight: 10, has: (p) => Boolean(p.business_name) },
  { label: "Category", weight: 12, has: (p) => Boolean(p.category) },
  { label: "City", weight: 12, has: (p) => Boolean(p.city) },
  { label: "Instagram", weight: 12, has: (p) => Boolean(p.instagram_handle) },
  { label: "TikTok", weight: 8, has: (p) => Boolean(p.tiktok_handle) },
  { label: "Phone / WhatsApp", weight: 12, has: (p) => Boolean(p.phone || p.whatsapp) },
  { label: "Bio / description", weight: 10, has: (p) => Boolean(p.bio || p.description) },
  { label: "Followers", weight: 6, has: (p) => p.follower_count != null },
  { label: "Last post date", weight: 6, has: (p) => Boolean(p.last_post_date) },
  { label: "Website / booking link", weight: 6, has: (p) => Boolean(p.website || p.booking_url) },
  { label: "Email", weight: 6, has: (p) => Boolean(p.email) },
];

export function scoreCompleteness(p: ScorableProspect): CompletenessResult {
  let got = 0;
  let total = 0;
  const present: string[] = [];
  const missing: string[] = [];
  for (const f of COMPLETENESS_FIELDS) {
    total += f.weight;
    if (f.has(p)) {
      got += f.weight;
      present.push(f.label);
    } else missing.push(f.label);
  }
  return { score: Math.round((got / total) * 100), present, missing };
}

// ── Contactability ─────────────────────────────────────────────────────────
export function contactChannels(p: Pick<ScorableProspect, "instagram_handle" | "tiktok_handle" | "whatsapp" | "phone" | "email">): string[] {
  const ch: string[] = [];
  if (p.instagram_handle) ch.push("instagram");
  if (p.whatsapp || p.phone) ch.push("whatsapp");
  if (p.tiktok_handle) ch.push("tiktok");
  if (p.email) ch.push("email");
  return ch;
}

// ── Priority ───────────────────────────────────────────────────────────────
export interface PriorityResult {
  score: number;
  tier: "high" | "medium" | "low";
  parts: { label: string; weight: number; value: number; contribution: number }[];
}

/**
 * Priority = who to contact first. Weighted blend, normalized 0–100:
 * ICP fit 40% · intent 15% · activity 15% · contactability 15% · data quality 10% · relevance 5%.
 */
export function scorePriority(p: ScorableProspect, icp: IcpResult, completeness: CompletenessResult): PriorityResult {
  const channels = contactChannels(p);
  const activityPct = (icp.components.activity / COMPONENT_MAX.activity) * 100;
  const contactPct = channels.length === 0 ? 0 : Math.min(100, 50 + channels.length * 17);
  const relevance = icp.components.category > 0 && icp.components.geography >= 9 ? 100 : icp.components.category > 0 ? 60 : 20;
  const parts = [
    { label: "ICP fit", weight: 0.4, value: icp.icp },
    { label: "Intent", weight: 0.15, value: icp.intent },
    { label: "Activity", weight: 0.15, value: activityPct },
    { label: "Contactability", weight: 0.15, value: contactPct },
    { label: "Data quality", weight: 0.1, value: completeness.score },
    { label: "Business relevance", weight: 0.05, value: relevance },
  ].map((x) => ({ ...x, value: Math.round(x.value), contribution: Math.round(x.value * x.weight * 10) / 10 }));
  let score = clamp(Math.round(parts.reduce((a, x) => a + x.value * x.weight, 0)));
  if (channels.length === 0) score = Math.min(score, 20); // can't contact = can't prioritise
  return { score, tier: score >= 70 ? "high" : score >= 45 ? "medium" : "low", parts };
}

export function clamp(n: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, n));
}

export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}
