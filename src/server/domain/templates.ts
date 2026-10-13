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

/** Categories whose work is visual, where "your nails look so good" is a natural compliment. */
const VISUAL = new Set([
  "hair_stylist", "beauty_salon", "barber", "nail_technician", "lash_technician", "makeup_artist", "skincare", "spa_wellness",
  "photographer", "media_production", "event_planner", "caterer", "fashion_designer", "designer", "tattoo_artist", "henna_artist",
  "personal_stylist", "florist", "cake_designer", "fitness_trainer",
]);

/** "your lash work" / "your nails" for their category, or "your work". */
export function craftPhrase(category: string | null | undefined): string {
  return CRAFT[category ?? ""] ?? "your work";
}

/** The five house message variants, by angle; drafts rotate through them when no angle is chosen. */
export const HOUSE_ANGLES = ["curiosity", "founder", "problem_first", "feedback_request", "product_intro"] as const;

const EMOJI = /\s*\p{Extended_Pictographic}[\u{FE0F}\u{200D}\p{Extended_Pictographic}]*/gu;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function templateMessage(input: TemplateInput): TemplateOutput {
  const { prospect: p, angle, channel, productName } = input;
  const seed = p.id;
  const vps = (input.valueProps?.length ? input.valueProps : CATEGORY_VALUE_PROPS[p.category ?? "other_service"] ?? ["bookings", "clients"]) as ValuePropKey[];
  const vp1 = VALUE_PROPS[vps[0]]?.short ?? VALUE_PROPS.bookings.short;
  const name = greetingName(p);
  const email = channel === "email";
  const sender = input.senderName ? input.senderName.split(" ")[0] : null;
  const smile = input.noEmojis ? "" : " 😊";
  const linkPara = input.link ? `\n\n${input.link}` : "";
  const finish = (body: string, subject: string | null): TemplateOutput => {
    let out = input.noEmojis ? body.replace(EMOJI, "") : body;
    if (input.link && !out.includes(input.link)) out += linkPara;
    // Email footer (sender identity, address, unsubscribe link) is appended at send time.
    if (email && sender) out += `\n\n${sender}`;
    out = noDashes(out.replace(/[ \t]+([,.?!])/g, "$1").replace(/[ \t]{2,}/g, " ")).replace(/\n{3,}/g, "\n\n").trim();
    return { body: out, subject: email ? subject : null, valueProps: vps.slice(0, 1) };
  };

  if (input.kind === "followup") {
    const hi = name ? `Hi ${name}` : "Hi";
    const step = input.step ?? 1;
    const body = step === 1
      ? pick([
          `${hi}! Just following up on my last message in case it got buried.\n\nWould you like me to send you the link to try ${productName}?${smile}`,
          `${hi}! Just checking in on my message from last week.\n\nHappy to send you the link to ${productName} if you'd like to take a look.${smile}`,
        ], seed, "f1")
      : step === 2
        ? `${hi}! One more thing I think you'd like. With ${productName} you can ${vp1}, all in one place.\n\nIf you want, I can help you set it up, it only takes a few minutes.`
        : `${hi}! I don't want to keep bugging you, so this will be my last message.\n\nIf you ever want an easier way to ${vp1}, I'd be happy to share ${productName} with you. Wishing you a great month!${smile}`;
    return finish(body, `Re: Quick question for ${name ?? p.business_name}`);
  }

  // Greetings and where we saw them, per channel: DMs say "your page"; emails can't.
  const hey = email ? (name ? `Hi ${name}` : "Hi") : name ? `Heyyyy ${name}` : "Heyyyy";
  const hi = name ? `Hi ${name}` : "Hi";
  const came = email ? "came across your business online" : "came across your page";
  const stumbled = email ? "came across your business online" : "stumbled on your page";
  const browsing = email ? "was looking at your business online" : "was going through your page";
  const craft = craftPhrase(p.category);
  const visual = VISUAL.has(p.category ?? "");
  const plural = /s$/.test(craft);
  const looksGood = visual ? `${craft} ${plural ? "look" : "looks"} so good!` : `${craft} really stood out to me.`;
  const offer = input.offer ? `\n\n${input.offer.replace(/[.!]?$/, ".")}` : "";
  const chosen = (HOUSE_ANGLES as readonly string[]).includes(angle) ? angle
    : angle === "outcome" || angle === "social_proof" ? "product_intro"
    : pick(HOUSE_ANGLES, seed, "angle");

  let body: string;
  switch (chosen) {
    case "curiosity": // 1. Feedback-first
      body = `${hey}! I ${came} and I really like your work, ${looksGood}

I'm actually working on something for service business owners and I'd love to get your perspective on something. I'm building ${productName} to help with things like managing clients, bookings and payments, and I'm curious how business owners currently handle all of that.${offer}

How's it been for you so far?`;
      break;
    case "founder": // 2. Founder reaching out to a potential user
      body = `${hi}! I ${came} and I love how you showcase your work. ${cap(craft)} caught my attention.

I'm the founder of ${productName}, an app I'm building for service business owners. The idea came from wanting to make the business side of things a little easier, especially keeping track of clients, bookings and payments.${offer}

I'm curious, how do you currently manage all of that for your business?`;
      break;
    case "problem_first": // 3. Problem-first
      body = `${hey}! ${visual ? `${cap(craft)} ${plural ? "are" : "is"} so neat omg 😭❤️ I ${browsing} and had to ask` : `I ${browsing} and I love what you're doing with ${craft}. Had to ask`}, how do you keep track of all your bookings? Especially when people are messaging you on different platforms.

I'm building ${productName}, which helps you manage your bookings, clients and payments in one place. I started thinking about how stressful it can get when everything is scattered across chats, so I'm curious how you handle yours!${offer}`;
      break;
    case "feedback_request": // 4. Asking for product feedback
      body = `${hi}! I ${stumbled} and I really like what you're doing with ${craft}. It's always nice seeing people put so much care into their work.

I'm currently building ${productName}, a tool that helps service business owners organise their bookings, clients, payments and follow-ups. I'm trying to get feedback from people who actually run these kinds of businesses so I can make it genuinely useful.${offer}

Would you be open to having a look at it sometime? I'd really appreciate your honest thoughts.`;
      break;
    default: // 5. Inviting them to try Orbit
      body = `${hey}! I just ${came} and ${visual ? `${craft} ${plural ? "are" : "is"} beautiful! 🥹❤️` : `I love what you're doing with ${craft}!`}

I'm building something called ${productName} for service business owners, to make it easier to keep track of clients, bookings and payments without having to jump between different chats and apps.

I'm looking for a few business owners to try it out, and I thought it could be useful for you too.${offer} Would you be open to checking it out?`;
  }
  return finish(body, `Quick question for ${name ?? p.business_name}`);
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
