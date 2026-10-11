import { CATEGORY_VALUE_PROPS, VALUE_PROPS, type ValuePropKey, type Channel } from "./taxonomy";

/**
 * Deterministic message templates. Used when no AI provider is configured
 * or the AI output fails validation, and as style anchors for the AI.
 *
 * Rules baked in: short, conversational, no corporate words, no fake
 * familiarity, no claims beyond the evidence passed in.
 */

export interface TemplateProspect {
  id: string;
  business_name: string;
  first_name: string | null;
  category: string | null;
  city: string | null;
  instagram_handle?: string | null;
  booking_url: string | null;
  signals: Record<string, { value: unknown }>;
  accepts_whatsapp_bookings?: boolean | null;
}

export interface TemplateInput {
  prospect: TemplateProspect;
  angle: string;
  channel: Channel;
  kind: "initial" | "followup";
  step?: number;          // followup step (1..n)
  productName: string;
  offer?: string | null;
  senderName?: string | null;
  link?: string | null;   // tracked link, if any
  noEmojis?: boolean;
  valueProps?: string[];
}

export interface TemplateOutput {
  body: string;
  subject: string | null;
  valueProps: string[];
}

/** Stable pseudo-random pick, so the same prospect always gets the same variant. */
function pick<T>(arr: readonly T[], seed: string, salt = ""): T {
  let h = 2166136261;
  for (const ch of seed + salt) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return arr[Math.abs(h) % arr.length];
}

/** What they do, as it reads after "I love what you're doing with …". */
const CRAFT: Record<string, string> = {
  hair_stylist: "your hair styling",
  beauty_salon: "your salon",
  barber: "your barbing",
  nail_technician: "your nails",
  lash_technician: "your lash work",
  makeup_artist: "your makeup",
  skincare: "your skincare treatments",
  spa_wellness: "your spa",
  photographer: "your photography",
  media_production: "your video work",
  event_planner: "your events",
  caterer: "your catering",
  fashion_designer: "your designs",
  designer: "your design work",
  marketing_agency: "your marketing work",
  consultant: "your consulting",
  coach: "your coaching",
  tutor: "your lessons",
  fitness_trainer: "your training sessions",
  cleaning_service: "your cleaning service",
  home_service: "your services",
  freelancer: "your work",
  tattoo_artist: "your tattoos",
  henna_artist: "your henna designs",
  personal_stylist: "your styling",
  florist: "your flowers",
  cake_designer: "your cakes",
  entertainer: "your entertainment",
  accountant: "your accounting practice",
  hr_recruiter: "your recruiting work",
  legal_practice: "your practice",
  immigration_consultant: "your immigration services",
};

/**
 * A first name only when it's explicit: the owner name on record, or a
 * business named after a person ("Nails by Teni", "Teni's Nail Bar").
 */
export function greetingName(p: TemplateProspect): string | null {
  if (p.first_name && p.first_name.length > 1) return p.first_name;
  const by = /\bby\s+([A-Z][a-z]{2,})\b/.exec(p.business_name);
  if (by) return by[1];
  const poss = /^([A-Z][a-z]{2,})['’]s\b/.exec(p.business_name);
  if (poss) return poss[1];
  return null;
}

/** People don't write em/en dashes in DMs; turn them (and spaced hyphens) into commas. */
export function noDashes(text: string): string {
  return text
    .replace(/[ \t]*[—–][ \t]*/g, ", ")
    .replace(/ +- +/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*([.!?])/g, "$1")
    .replace(/^,\s*/gm, "");
}

/** Where we can honestly say we saw them. */
function seenOn(p: TemplateProspect, channel: Channel): string {
  return channel === "instagram" || channel === "tiktok" || channel === "facebook" ? "your page" : "your business online";
}

export function templateMessage(input: TemplateInput): TemplateOutput {
  const { prospect: p, angle, channel, productName } = input;
  const seed = p.id;
  const vps = (input.valueProps?.length ? input.valueProps : CATEGORY_VALUE_PROPS[p.category ?? "other_service"] ?? ["bookings", "clients"]) as ValuePropKey[];
  const vp1 = VALUE_PROPS[vps[0]]?.short ?? VALUE_PROPS.bookings.short;
  const name = greetingName(p);
  const hi = name ? `Hi ${name}` : "Hi there";
  const sender = input.senderName ? input.senderName.split(" ")[0] : null;
  const smile = input.noEmojis ? "" : " 😊";
  const craft = CRAFT[p.category ?? ""] ?? p.business_name;
  const linkLine = input.link ? `

${input.link}` : "";
  let body: string;

  if (input.kind === "followup") {
    const step = input.step ?? 1;
    if (step === 1) body = pick([
      `${hi}, just following up on my last message in case it got buried. Would you like me to send you the link to try ${productName}?${smile}`,
      `${hi}, just checking in on my message from last week. Happy to send you the link to ${productName} if you'd like to take a look.${smile}`,
    ], seed, "f1");
    else if (step === 2) body = `${hi}, one more thing I think you'd like. With ${productName} you can ${vp1}, all in one place. If you want, I can help you set it up, it only takes a few minutes.${linkLine}`;
    else body = `${hi}, I don't want to keep bugging you, so this will be my last message. If you ever want an easier way to ${vp1}, I'd be happy to share ${productName} with you. Wishing you a great month!${smile}`;
    if (channel === "email" && sender) body += `

${sender}`;
    return { body: noDashes(body).trim(), subject: channel === "email" ? `Re: Quick question for ${name ?? p.business_name}` : null, valueProps: vps.slice(0, 1) };
  }

  const opener = pick([
    `${hi}, I came across ${name ? seenOn(p, channel) : p.business_name} and I love what you're doing with ${craft}.`,
    `${hi}, I came across ${name ? seenOn(p, channel) : p.business_name} and I really like what you're doing with ${craft}.`,
  ], seed, "o");
  const pitch = `${sender ? `I'm ${sender} and I'm building` : "I'm building"} ${productName}, a simple tool that helps service business owners manage bookings, clients, payments and follow-ups in one place.`;
  const middle = angle === "feedback_request"
    ? "I'm getting a few business owners to try it out, and I'd really love your honest feedback on it."
    : pick([
        "I'm currently getting a few business owners to try it out, and I thought it could be useful for your business too.",
        `I'm getting a small group of business owners to try it out right now, and I thought it could really help ${p.business_name}.`,
      ], seed, "m");
  const offer = input.offer ? `${input.offer.replace(/[.!]?$/, ".")} ` : "";
  const close = pick([
    `Would you be open to me sharing the link with you?${smile}`,
    `Would you like me to send you the link so you can check it out?${smile}`,
  ], seed, "c");

  body = `${opener} ${pitch}

${middle}

${offer}${close}`;
  if (input.link && !body.includes(input.link)) body += linkLine;
  // Email footer (sender identity, address, unsubscribe link) is appended at send time.
  if (channel === "email") body += `

Thanks,
${sender ?? `The ${productName} team`}`;
  return {
    body: noDashes(body.replace(/\s+([,.?!])/g, "$1").replace(/ {2,}/g, " ")).trim(),
    subject: channel === "email" ? `Quick question for ${name ?? p.business_name}` : null,
    valueProps: vps.slice(0, 1),
  };
}

/** Suggested responses to common reply intents (fallback for the AI reply assistant). */
export function templateReply(intent: string, p: { first_name: string | null; category: string | null }, productName: string, link?: string | null): string {
  const hi = p.first_name ? `Thanks ${p.first_name}!` : "Thanks for getting back to me!";
  const vps = (CATEGORY_VALUE_PROPS[p.category ?? "other_service"] ?? ["bookings", "clients"]) as ValuePropKey[];
  const l = link ? ` Here's the link: ${link}` : "";
  switch (intent) {
    case "pricing":
      return `${hi} You can start on ${productName} for free, no card needed. Paid plans only matter once you want the extras. Want me to send you the link to get started?${l}`;
    case "interested":
    case "signup_intent":
      return `${hi} Here's how to get started. It takes about 2 minutes to set up your services and start taking bookings.${l || " Want me to send the link?"}`;
    case "demo_request":
      return `${hi} Happy to show you. What day and time works for a quick 10-minute call this week?`;
    case "competitor":
      return `That makes sense. ${productName} isn't just a booking tool, it also helps you ${VALUE_PROPS[vps[1] ?? "clients"].short} and ${VALUE_PROPS[vps[2] ?? "payments"].short}, all in one place. If you're open to it, I'd love for you to take a quick look and tell me what you think.`;
    case "maybe_later":
      return `No problem at all! I'll check back in a few weeks. If anything changes before then, just message me.`;
    case "question":
      return `${hi} Good question! `;
    case "not_interested":
      return `No worries at all, thanks for letting me know. Wishing you a great month!`;
    case "wrong_person":
      return `Sorry about that, and thanks for letting me know!`;
    default:
      return `${hi}`;
  }
}
