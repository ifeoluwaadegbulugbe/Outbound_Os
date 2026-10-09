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

const CRAFT: Record<string, string> = {
  hair_stylist: "hair",
  barber: "cuts",
  nail_technician: "nail sets",
  lash_technician: "lash work",
  makeup_artist: "glam",
  skincare: "skin treatments",
  spa_wellness: "sessions",
  fitness_trainer: "training sessions",
  photographer: "shoots",
  event_planner: "events",
  fashion_designer: "designs",
  coach: "coaching sessions",
  consultant: "client work",
  tutor: "lessons",
  freelancer: "projects",
  caterer: "orders",
};

const CLIENT_WORD: Record<string, string> = {
  photographer: "clients",
  event_planner: "clients",
  coach: "clients",
  consultant: "clients",
  freelancer: "clients",
  fashion_designer: "customers",
  caterer: "customers",
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

function greet(p: TemplateProspect, seed: string): string {
  const name = greetingName(p);
  return name ? pick([`Hi ${name}`, `Hey ${name}`], seed, "g") : pick([`Hi ${p.business_name} team`, `Hello ${p.business_name}`], seed, "g");
}

/** What we can truthfully say we noticed. */
function observation(p: TemplateProspect, seed: string): string | null {
  const s = (k: string) => p.signals?.[k]?.value === true;
  if (s("dmBookings")) return pick(["I noticed bookings go through your DMs", "saw that clients book you through DMs"], seed, "o");
  if (s("whatsappBookings") || p.accepts_whatsapp_bookings) return pick(["saw you take bookings on WhatsApp", "noticed clients book you on WhatsApp"], seed, "o");
  if (s("manualPayments")) return "noticed you take deposits before bookings";
  if (p.booking_url) return "saw you already have a booking link set up";
  return null;
}

function craftLine(p: TemplateProspect, seed: string): string {
  const craft = CRAFT[p.category ?? ""] ?? "work";
  const where = p.city ? ` in ${p.city}` : "";
  return pick([`came across your ${craft}${where}`, `been seeing your ${craft}${where}`, `found your page${where}`], seed, "c");
}

export function templateMessage(input: TemplateInput): TemplateOutput {
  const { prospect: p, angle, channel, productName } = input;
  const seed = p.id;
  const vps = (input.valueProps?.length ? input.valueProps : CATEGORY_VALUE_PROPS[p.category ?? "other_service"] ?? ["bookings", "clients"]) as ValuePropKey[];
  const vp1 = VALUE_PROPS[vps[0]]?.short ?? VALUE_PROPS.bookings.short;
  const clients = CLIENT_WORD[p.category ?? ""] ?? "clients";
  const hi = greet(p, seed);
  const obs = observation(p, seed);
  const sender = input.senderName ? input.senderName.split(" ")[0] : null;
  const intro = sender ? `I'm ${sender}, I'm building ${productName}` : `I'm building ${productName}`;
  const linkLine = input.link ? `\n\n${input.link}` : "";
  const em = input.noEmojis ? "" : pick(["", "", " 🙂"], seed, "e");
  let body: string;

  if (input.kind === "followup") {
    const step = input.step ?? 1;
    if (step === 1) body = pick([`${hi}, just bumping this in case it got buried. No pressure at all.`, `${hi}, quick nudge on my last message — happy to share more if useful.`], seed, "f1");
    else if (step === 2) body = `${hi}, one specific thing ${productName} does for businesses like yours: it lets you ${vp1}. If that's useful, I can set you up in a few minutes.${linkLine}`;
    else body = `${hi}, I'll stop here so I'm not a bother. If you ever want an easier way to ${vp1}, ${productName} is free to try. Wishing you a great month!${em}`;
    return { body: body.trim(), subject: channel === "email" ? `Re: ${p.business_name}` : null, valueProps: vps.slice(0, 1) };
  }

  switch (angle) {
    case "problem_first":
      body = obs
        ? `${hi}, ${obs}. ${intro} — it lets you ${vp1}. Would you be open to trying it?${em}`
        : `${hi}, ${craftLine(p, seed)}. Quick question: how do you keep track of bookings right now? ${intro} to make that part easier.`;
      break;
    case "curiosity":
      body = `${hi}, ${craftLine(p, seed)} — love it. Curious, how do you handle bookings and reminders at the moment? Asking because ${sender ? `I'm ${sender} and ` : ""}I'm building ${productName} for businesses like yours.`;
      break;
    case "outcome":
      body = `${hi}, ${craftLine(p, seed)}. Thought this might help: ${productName} lets you ${vp1}. Fewer no-shows, less admin. Want me to send you a link to try it free?`;
      break;
    case "feedback_request":
      body = obs
        ? `${hi}, ${obs}. ${intro} and I'd really value your honest opinion as someone who runs ${clients} bookings every day. Could I show you and get your feedback?`
        : `${hi}, ${intro} for ${CRAFT[p.category ?? ""] ? `${p.category?.replace(/_/g, " ")}s` : "service businesses"} and I'd love your honest take on it. Would you be open to a quick look?`;
      break;
    case "founder":
      body = `${hi}, ${sender ? `${sender} here — ` : ""}founder of ${productName}. ${craftLine(p, seed)} and thought you'd be a great fit for what we're building: one place to ${vp1}. Can I set you up for free?`;
      break;
    case "product_intro":
    default:
      body = `${hi}, ${intro} — a simple app that helps ${clients.replace(/s$/, "")}-facing businesses ${vp1}. ${craftLine(p, seed).replace(/^./, (c) => c.toUpperCase())} and thought it could be useful. ${input.offer ? `${input.offer}. ` : ""}Interested?`;
  }
  if (input.link && !body.includes(input.link)) body += linkLine;
  // Email footer (sender identity, address, unsubscribe link) is appended at send time.
  if (channel === "email") body += `\n\nThanks,\n${sender ?? `The ${productName} team`}`;
  return {
    body: body.replace(/\s+([,.?!])/g, "$1").replace(/ {2,}/g, " ").trim(),
    subject: channel === "email" ? pick([`Quick question, ${p.first_name ?? p.business_name}`, `${p.business_name} + ${productName}`], seed, "s") : null,
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
      return `${hi} You can start on ${productName} for free — no card needed. Paid plans only matter once you want the extras. Want me to send you the link to get started?${l}`;
    case "interested":
    case "signup_intent":
      return `${hi} Here's how to get started — it takes about 2 minutes to set up your services and start taking bookings.${l || " Want me to send the link?"}`;
    case "demo_request":
      return `${hi} Happy to show you. What day and time works for a quick 10-minute call this week?`;
    case "competitor":
      return `That makes sense. ${productName} isn't just a booking tool — it also helps you ${VALUE_PROPS[vps[1] ?? "clients"].short} and ${VALUE_PROPS[vps[2] ?? "payments"].short}, all in one place. If you're open to it, I'd love for you to take a quick look and tell me what you think.`;
    case "maybe_later":
      return `No problem at all! I'll check back in a few weeks. If anything changes before then, just message me.`;
    case "question":
      return `${hi} Good question — `;
    case "not_interested":
      return `No worries at all, thanks for letting me know. Wishing you a great month!`;
    case "wrong_person":
      return `Sorry about that, and thanks for letting me know!`;
    default:
      return `${hi}`;
  }
}
