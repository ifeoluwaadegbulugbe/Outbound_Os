/**
 * Rule-based reply classification. Runs FIRST for every inbound message.
 * Opt-out detection is deliberately deterministic: we never want an LLM's
 * judgement to be the only thing standing between a "stop messaging me" and
 * another follow-up. The AI classifier (src/server/ai/tasks) refines intent
 * for everything else, and falls back to these rules if unavailable.
 */

export const REPLY_INTENTS = [
  "interested", "pricing", "question", "demo_request", "signup_intent", "not_interested",
  "competitor", "maybe_later", "wrong_person", "spam", "opt_out", "out_of_office",
] as const;
export type ReplyIntent = (typeof REPLY_INTENTS)[number];

export const INTENT_LABELS: Record<ReplyIntent, string> = {
  interested: "Interested",
  pricing: "Pricing",
  question: "Question",
  demo_request: "Demo request",
  signup_intent: "Signup intent",
  not_interested: "Not interested",
  competitor: "Already using competitor",
  maybe_later: "Maybe later",
  wrong_person: "Wrong person",
  spam: "Spam",
  opt_out: "Opt-out",
  out_of_office: "Out of office",
};

export interface RuleClassification {
  intent: ReplyIntent;
  confidence: number;
  matched: string | null;
  /** True when this result must not be overridden by AI. */
  authoritative: boolean;
}

const OPT_OUT = [
  /\b(stop|unsubscribe|opt[\s-]?out|remove me|take me off)\b/i,
  /\b(don'?t|do not|pls don'?t|please don'?t|never)\s+(message|text|contact|dm|msg|email|call|disturb)\b/i,
  /\bstop (messaging|texting|contacting|dming|disturbing)\b/i,
  /\b(leave me alone|not interested,? stop|block(ed)? you|reported you|this is spam)\b/i,
  /\bwho gave you my (number|contact)\b/i,
];

const RULES: { intent: ReplyIntent; confidence: number; patterns: RegExp[] }[] = [
  { intent: "out_of_office", confidence: 92, patterns: [/\b(out of (the )?office|on (annual |maternity )?leave|away (from the office )?until|automatic reply|auto-?reply|currently unavailable and will respond)\b/i] },
  { intent: "signup_intent", confidence: 85, patterns: [/\b(signed up|just signed|created (an|my) account|how do i (sign up|register|join)|send (me )?the link|where do i sign up|i'?ll sign up|let me try it)\b/i] },
  { intent: "demo_request", confidence: 85, patterns: [/\b(demo|show me how|walk me through|call me|can we (talk|call|meet)|zoom|google meet|video call)\b/i] },
  { intent: "pricing", confidence: 88, patterns: [/\b(how much|price|pricing|cost|subscription|fee|charges?|is it free|naira|₦|per month|monthly)\b/i] },
  { intent: "competitor", confidence: 75, patterns: [/\b(already (use|have|using)|i use (fresha|booksy|calendly|setmore|bumpa|square|acuity)|have a booking (app|system|site))\b/i] },
  { intent: "maybe_later", confidence: 75, patterns: [/\b(maybe later|not now|another time|next (week|month)|later in the|busy (now|right now)|get back to you|remind me)\b/i] },
  { intent: "wrong_person", confidence: 80, patterns: [/\b(wrong (person|number|account)|not the owner|i don'?t own|not my business)\b/i] },
  { intent: "not_interested", confidence: 82, patterns: [/\b(not interested|no thanks|no thank you|i'?m good|we'?re good|don'?t need|no need)\b/i] },
  { intent: "interested", confidence: 78, patterns: [/\b(interested|sounds (good|great|interesting)|tell me more|i'?d like|i would like|okay send|ok send|yes please|love (to|this)|looks (good|interesting|nice)|how does it work)\b/i] },
  { intent: "question", confidence: 60, patterns: [/\?\s*$/m, /\b(what is|what'?s|how do|can it|does it|is it)\b/i] },
];

export function classifyByRules(text: string): RuleClassification {
  const t = text.trim();
  for (const re of OPT_OUT) {
    const m = re.exec(t);
    if (m) return { intent: "opt_out", confidence: 97, matched: m[0], authoritative: true };
  }
  for (const r of RULES) {
    for (const re of r.patterns) {
      const m = re.exec(t);
      if (m) return { intent: r.intent, confidence: r.confidence, matched: m[0], authoritative: false };
    }
  }
  return { intent: "question", confidence: 35, matched: null, authoritative: false };
}

/** Status a classified reply should move the prospect to. */
export function statusForIntent(intent: ReplyIntent): "DO_NOT_CONTACT" | "INTERESTED" | "NOT_INTERESTED" | "REPLIED" | "DEMO" | "FOLLOW_UP" | "LOST" {
  switch (intent) {
    case "opt_out":
      return "DO_NOT_CONTACT";
    case "interested":
    case "pricing":
    case "signup_intent":
      return "INTERESTED";
    case "demo_request":
      return "DEMO";
    case "not_interested":
    case "competitor":
      return "NOT_INTERESTED";
    case "maybe_later":
      return "FOLLOW_UP";
    case "wrong_person":
    case "spam":
      return "LOST";
    default:
      return "REPLIED";
  }
}

export function needsResponse(intent: ReplyIntent): boolean {
  return !["opt_out", "spam", "not_interested", "wrong_person", "out_of_office"].includes(intent);
}
