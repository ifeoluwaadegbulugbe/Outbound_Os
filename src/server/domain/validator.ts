import { CATEGORIES } from "./taxonomy";
import { CHANNEL_SPECS, channelAvailable, type ContactTarget } from "./channels";
import type { Channel, ProspectStatus } from "./taxonomy";
import { outreachBlockReason } from "./status";
import { greetingName, craftPhrase } from "./templates";

/**
 * Pre-send quality and safety gate. Every outreach message is validated on
 * generation, on every edit, and again at approval/send time. Any issue with
 * severity "block" makes the message unsendable, with an explanation.
 */

export interface ValidationIssue {
  code: string;
  severity: "block" | "warn";
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  stats: { chars: number; emojis: number; links: number };
}

export interface CampaignConstraints {
  maxChars?: number;
  noEmojis?: boolean;
  mentionBookingLinkOnlyIfPresent?: boolean;
  bannedPhrases?: string[];
  requireName?: boolean;
}

export interface ValidationInput {
  body: string;
  subject?: string | null;
  channel: Channel;
  kind: "initial" | "followup" | "reply";
  prospect: ContactTarget & {
    business_name: string;
    owner_name?: string | null;
    first_name?: string | null;
    category: string | null;
    status: ProspectStatus;
    do_not_contact: boolean;
    booking_url: string | null;
    accepts_whatsapp_bookings: boolean | null;
    follower_count: number | null;
    signals: Record<string, { value: unknown }>;
  };
  context: {
    workspacePaused: boolean;
    /** Prior sent messages of kind 'initial' to this prospect, any channel. */
    previousInitialSentAt?: Date | string | null;
    previousInitialChannel?: string | null;
    hasPendingFollowup?: boolean;
    /** Verified social-proof statements from workspace settings. */
    verifiedProof?: string[];
  };
  constraints?: CampaignConstraints;
}

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const LINK_RE = /\bhttps?:\/\/\S+|\bwww\.\S+/gi;

const AI_TELLS = [
  "as an ai", "i hope this message finds you well", "i hope this finds you well", "in today's fast-paced",
  "in today's digital", "i came across your profile and was impressed", "unlock your potential", "elevate your",
  "take your business to the next level", "revolutionize", "revolutionise", "game-changer", "game changer",
  "seamlessly", "seamless", "leverage", "synergy", "cutting-edge", "cutting edge", "robust solution",
  "streamline your", "empower your", "delve", "tailored solution", "comprehensive solution", "i wanted to reach out",
];
const CORPORATE = ["dear ", "kindly", "esteemed", "valued customer", "to whom it may concern", "please be informed", "we are pleased", "do the needful"];
const FAKE_FAMILIARITY = [
  /\b(i|we) (loved|enjoyed) (my|our) (appointment|session|visit|service)/i,
  /\b(i|we)('ve| have) (used|tried|booked) (your|you)/i,
  /\bas (your|a) (loyal |regular )?(client|customer)\b/i,
  /\bwhen i (came|visited|was) (to|at) your\b/i,
  /\bmy (friend|sister|cousin) (recommended|told me about) you\b/i,
  /\bremember me\b/i,
];
const SPAM = [/\b(click here|act now|limited time|100% free|guaranteed|risk[- ]free|no strings attached|earn money|make money)\b/i, /!!+/, /\$\$+|₦₦+/];
const PLACEHOLDER = /\{\{.*?\}\}|\[(?:name|first name|business|business name|city|link)\]|<(?:name|business)>|\bXXX\b|\bINSERT\b/i;
const SOCIAL_PROOF = /\b(\d[\d,.]*\+?\s*(businesses|stylists|users|vendors|customers|people|salons|techs?)\b|hundreds of|thousands of|trusted by|used by (many|lots|top))/i;

export function validateMessage(input: ValidationInput): ValidationResult {
  const issues: ValidationIssue[] = [];
  const block = (code: string, message: string) => issues.push({ code, severity: "block", message });
  const warn = (code: string, message: string) => issues.push({ code, severity: "warn", message });
  const { body, channel, prospect: p, context: ctx } = input;
  const c = input.constraints ?? {};
  const spec = CHANNEL_SPECS[channel];
  const text = body.trim();
  const lower = text.toLowerCase();
  const emojis = (text.match(EMOJI_RE) ?? []).length;
  const links = (text.match(LINK_RE) ?? []).length;

  // ── Eligibility ──
  if (ctx.workspacePaused) block("outreach_paused", "All outreach is paused (Settings → Pause all outreach).");
  if (input.kind !== "reply") {
    const reason = outreachBlockReason(p);
    if (reason) block("not_contactable", `${reason}.`);
  } else if (p.do_not_contact) {
    block("not_contactable", "Prospect is on the do-not-contact list.");
  }
  if (!channelAvailable(channel, p)) block("channel_unavailable", `No ${spec.label} contact for this prospect.`);
  if (input.kind === "initial" && ctx.previousInitialSentAt) {
    block("already_contacted", `Already contacted${ctx.previousInitialChannel ? ` on ${ctx.previousInitialChannel}` : ""} on ${new Date(ctx.previousInitialSentAt).toDateString()}. Use a follow-up instead.`);
  }
  if (input.kind === "initial" && ctx.hasPendingFollowup) block("followup_active", "A follow-up sequence is already active for this prospect.");

  // ── Content ──
  if (!text) block("empty", "Message is empty.");
  if (PLACEHOLDER.test(text)) block("placeholder", "Message still contains a template placeholder.");
  const maxChars = Math.min(spec.maxChars, c.maxChars ?? Infinity);
  if (text.length > maxChars) block("too_long", `Too long: ${text.length} characters (limit ${maxChars}).`);
  else if (text.length > spec.idealChars && !c.maxChars) warn("long", `${text.length} characters — messages under ${spec.idealChars} get more replies on ${spec.label}.`);

  if (c.noEmojis && emojis > 0) block("emoji_forbidden", "Campaign says no emojis.");
  else if (emojis > 2) warn("emoji_heavy", `${emojis} emojis — keep it to one or two.`);

  for (const t of AI_TELLS) if (lower.includes(t)) warn("ai_language", `Sounds generic/AI-written: "${t}".`);
  for (const t of CORPORATE) if (lower.includes(t) || lower.startsWith(t.trim())) warn("corporate", `Too formal for this audience: "${t.trim()}".`);
  for (const t of c.bannedPhrases ?? []) if (t && lower.includes(t.toLowerCase())) block("banned_phrase", `Campaign bans the phrase "${t}".`);
  for (const re of FAKE_FAMILIARITY) {
    const m = re.exec(text);
    if (m) block("fake_familiarity", `Implies a relationship that doesn't exist: "${m[0]}".`);
  }
  for (const re of SPAM) {
    const m = re.exec(text);
    if (m) warn("spammy", `Spam trigger: "${m[0]}".`);
  }
  const words = text.split(/\s+/).filter((w) => /[a-z]/i.test(w));
  const caps = words.filter((w) => w.length > 3 && w === w.toUpperCase() && /[A-Z]/.test(w));
  if (caps.length >= 3) warn("shouting", "Too many ALL-CAPS words.");
  if (links > 1) warn("many_links", `${links} links — one is plenty.`);

  // ── Factual accuracy ──
  // Wrong handle: an @mention that isn't the prospect's own handle.
  for (const m of text.matchAll(/@([a-z0-9._]{2,30})/gi)) {
    const h = m[1].toLowerCase().replace(/\.$/, "");
    if (h !== (p.instagram_handle ?? "").toLowerCase() && h !== (p.tiktok_handle ?? "").toLowerCase()) {
      block("wrong_handle", `Mentions @${h}, which isn't this prospect.`);
    }
  }
  // Category mismatch: message talks about another category's craft.
  if (p.category) {
    const own = CATEGORIES.find((x) => x.key === p.category);
    const ownWords = new Set(own?.keywords ?? []);
    for (const cat of CATEGORIES) {
      if (cat.key === p.category || cat.key === "other_service") continue;
      const strong = cat.keywords.filter((k) => k.length >= 5 && !ownWords.has(k) && !k.includes("salon"));
      const hit = strong.find((k) => new RegExp(`\\b${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(text));
      if (hit) {
        warn("category_mismatch", `Mentions "${hit}" but this prospect is categorised as ${own?.label ?? p.category}.`);
        break;
      }
    }
  }
  // Claims about the prospect's workflow need evidence.
  const sig = (k: string) => p.signals?.[k]?.value === true;
  if (/\b(booking link|link in (your )?bio)\b/i.test(text) && !p.booking_url && (c.mentionBookingLinkOnlyIfPresent ?? true)) {
    block("unsupported_claim", "Mentions their booking link, but none is on record.");
  }
  if (/\b(you|your)\b[^.?!]{0,40}\bwhatsapp\b|\bwhatsapp\b[^.?!]{0,30}\b(bookings?|orders?|appointments?)\b/i.test(text) && !(p.accepts_whatsapp_bookings || sig("whatsappBookings"))) {
    warn("unverified_claim", "Implies they take bookings on WhatsApp — no evidence on record. Rephrase as a question or remove.");
  }
  if (/\b(in|through|via) (your )?dms?\b/i.test(text) && !sig("dmBookings")) {
    warn("unverified_claim", "Implies they take bookings in DMs — not confirmed by their bio.");
  }
  const followerClaim = /(\d[\d,.]*)\s*k?\s*followers/i.exec(text);
  if (followerClaim) warn("follower_mention", "Mentioning follower counts can feel creepy — consider removing.");
  if (SOCIAL_PROOF.test(text)) {
    const m = SOCIAL_PROOF.exec(text)![0];
    const verified = (ctx.verifiedProof ?? []).some((v) => v && lower.includes(v.toLowerCase()));
    if (!verified) block("unverified_social_proof", `Social proof "${m}" isn't in your verified proof list (Settings).`);
  }

  // ── Personalization ──
  const nameTokens = [p.first_name, p.owner_name?.split(" ")[0], greetingName({ ...p, id: "", city: null, first_name: p.first_name ?? null }), p.business_name, p.instagram_handle, p.tiktok_handle]
    .filter(Boolean)
    .map((s) => s!.toLowerCase());
  // Naming what they do ("your lash work") is personal too; generic "your work" isn't.
  const craft = craftPhrase(p.category);
  const personalized = nameTokens.some((n) => n.length >= 3 && lower.includes(n)) || (craft !== "your work" && lower.includes(craft));
  if (!personalized && input.kind === "initial") {
    if (c.requireName) block("not_personalized", "Campaign requires using their name or business name.");
    else warn("not_personalized", "Doesn't mention their name or business — feels like a mass message.");
  }

  // ── Channel rules ──
  if (channel === "email" && input.kind !== "reply" && /\b(unsubscribe)\b/i.test(text)) {
    warn("duplicate_footer", "No need to add an unsubscribe line — it's added to the footer automatically.");
  }
  if (spec.requiresOptOutLine && input.kind !== "reply" && !/\b(stop|unsubscribe|opt out|won'?t (email|message) (you )?again|let me know if you('d| would) rather not)\b/i.test(text)) {
    block("missing_opt_out", "Email needs a simple opt-out line (e.g. \"Reply stop and I won't email again\").");
  }
  if (channel === "email" && input.kind === "initial" && !input.subject?.trim()) block("missing_subject", "Email needs a subject line.");

  return { ok: !issues.some((i) => i.severity === "block"), issues, stats: { chars: text.length, emojis, links } };
}
