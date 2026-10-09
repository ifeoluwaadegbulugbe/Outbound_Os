import { categoryLabel } from "../domain/taxonomy";
import { daysSince, formatCount } from "../domain/scoring";

/**
 * Turns a prospect record into a numbered list of KNOWN FACTS, each traceable
 * to a field or a quoted bio fragment, plus explicit UNKNOWNS. AI tasks may
 * only cite these ids; anything else they say must be labelled inference.
 */

export interface Fact {
  id: string;
  text: string;
  /** Field or evidence source, shown in the UI on hover. */
  source: string;
}

export interface FactSheet {
  facts: Fact[];
  unknowns: string[];
}

export interface FactProspect {
  business_name: string;
  owner_name: string | null;
  category: string | null;
  services: string[];
  city: string | null;
  area: string | null;
  country: string | null;
  bio: string | null;
  description: string | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  follower_count: number | null;
  last_post_date: Date | string | null;
  posting_frequency: number | null;
  booking_url: string | null;
  website: string | null;
  phone: string | null;
  whatsapp: string | null;
  email: string | null;
  signals: Record<string, { value: unknown; source: string; quote?: string }>;
}

export function buildFacts(p: FactProspect, now = new Date()): FactSheet {
  const facts: Fact[] = [];
  const unknowns: string[] = [];
  const add = (text: string, source: string) => facts.push({ id: `f${facts.length + 1}`, text, source });

  add(`Business name: ${p.business_name}`, "business_name");
  if (p.owner_name) add(`Owner name on record: ${p.owner_name}`, "owner_name");
  if (p.category) add(`Category: ${categoryLabel(p.category)}`, p.signals?.category ? `bio: "${p.signals.category.quote ?? ""}"` : "category");
  else unknowns.push("Exact business category");
  if (p.city) add(`Located in ${p.area ? `${p.area}, ` : ""}${p.city}`, "city");
  else unknowns.push("Location");
  if (p.services?.length) add(`Services mentioned: ${p.services.slice(0, 6).join(", ")}`, "services");
  if (p.instagram_handle) add(`Instagram: @${p.instagram_handle}${p.follower_count != null ? ` with ${formatCount(p.follower_count)} followers` : ""}`, "instagram_handle");
  if (p.tiktok_handle) add(`TikTok: @${p.tiktok_handle}`, "tiktok_handle");
  const days = daysSince(p.last_post_date, now);
  if (days != null) add(`Last posted ${days === 0 ? "today" : `${days} days ago`}`, "last_post_date");
  else unknowns.push("How recently they post");
  if (p.posting_frequency != null && p.posting_frequency > 0) add(`Posts about ${Math.round(p.posting_frequency)} times per week`, "posting_frequency");
  if (p.bio) add(`Bio text: "${p.bio.slice(0, 300)}"`, "bio");

  const sig = p.signals ?? {};
  const quoteFact = (key: string, label: string) => {
    const s = sig[key];
    if (s?.value === true) add(`${label}${s.quote ? ` (bio says "${s.quote.replace(/^…|…$/g, "")}")` : ""}`, `${s.source}${s.quote ? `: "${s.quote}"` : ""}`);
  };
  quoteFact("dmBookings", "Asks clients to book via DM");
  quoteFact("whatsappBookings", "Takes bookings or enquiries on WhatsApp");
  quoteFact("acceptsBookings", "Takes bookings/appointments");
  quoteFact("manualPayments", "Asks for deposits/transfers before booking");
  quoteFact("onlinePayments", "Uses an online payment link");
  if (sig.schedulingTool) add(`Already uses a booking tool: ${String(sig.schedulingTool.value)}`, sig.schedulingTool.source);
  if (p.booking_url) add(`Has a booking link: ${p.booking_url}`, "booking_url");
  if (p.website) add(`Has a website: ${p.website}`, "website");

  if (!sig.whatsappBookings) unknowns.push("Whether they take bookings on WhatsApp");
  if (!sig.dmBookings && !sig.acceptsBookings && !p.booking_url) unknowns.push("How clients book them");
  if (!sig.manualPayments && !sig.onlinePayments) unknowns.push("How they collect payment");
  if (!p.email) unknowns.push("Email address");
  if (!sig.schedulingTool) unknowns.push("Whether they already use business software");
  return { facts, unknowns };
}

export function factsBlock(sheet: FactSheet): string {
  return [
    "KNOWN FACTS (cite by id):",
    ...sheet.facts.map((f) => `${f.id}. ${f.text}`),
    "",
    "UNKNOWN (never state these as fact):",
    ...sheet.unknowns.map((u) => `- ${u}`),
  ].join("\n");
}
