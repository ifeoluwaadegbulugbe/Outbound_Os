import { z } from "zod";
import type { Q } from "../../db";
import { runTask, type TaskResult, type AiLogTarget } from "../run";
import { classifyByRules, REPLY_INTENTS, type ReplyIntent } from "../../domain/classifier";
import { templateReply, noDashes } from "../../domain/templates";
import { buildFacts, factsBlock, type FactProspect } from "../facts";
import { validateMessage } from "../../domain/validator";
import type { Channel, ProspectStatus } from "../../domain/taxonomy";

// ── Classification ─────────────────────────────────────────────────────────
export const classifyOutput = z.object({
  intent: z.enum(REPLY_INTENTS),
  confidence: z.number().int().min(0).max(100),
  summary: z.string().max(200),
  next_action: z.string().max(140),
});
export type Classification = z.infer<typeof classifyOutput> & { source: string; matched?: string | null };

const CLASSIFY_SYSTEM = `You classify replies from small-business owners to a cold outreach message about a business app.
Intents: interested, pricing (asks cost), question (asks how something works), demo_request, signup_intent (says they signed up / wants link),
not_interested, competitor (already uses another tool), maybe_later, wrong_person, spam, opt_out (asks not to be contacted).
If there's ANY request to stop contact, the intent is opt_out. confidence is 0-100. summary: one neutral sentence. next_action: what the sender should do next.`;

export async function classifyReply(q: AiLogTarget, workspaceId: string, text: string, previousOutbound: string | null): Promise<Classification> {
  const rules = classifyByRules(text);
  // Opt-outs are decided by deterministic rules alone — never overridden by AI.
  if (rules.authoritative) {
    return { intent: rules.intent, confidence: rules.confidence, summary: "Asked not to be contacted again.", next_action: "Do not contact. Already suppressed.", source: "rules", matched: rules.matched };
  }
  const res = await runTask(q, workspaceId, {
    task: "reply.classify",
    input: { text, previousOutbound },
    output: classifyOutput,
    system: CLASSIFY_SYSTEM,
    maxTokens: 250,
    temperature: 0,
    buildPrompt: (i) => `${i.previousOutbound ? `Our message:\n"""${i.previousOutbound.slice(0, 600)}"""\n\n` : ""}Their reply:\n"""${i.text.slice(0, 1200)}"""`,
    fallback: () => ({ intent: rules.intent, confidence: rules.confidence, summary: summarize(rules.intent), next_action: nextAction(rules.intent) }),
  });
  // Belt and braces: if the AI says opt_out, honour it; if rules saw opt-out, we never got here.
  return { ...res.output, source: res.source, matched: rules.matched };
}

function summarize(intent: ReplyIntent): string {
  return {
    interested: "Expressed interest.", pricing: "Asked about pricing.", question: "Asked a question.", demo_request: "Wants a demo or call.",
    signup_intent: "Ready to sign up.", not_interested: "Not interested.", competitor: "Already uses another tool.", maybe_later: "Interested later, not now.",
    wrong_person: "Not the right contact.", spam: "Irrelevant or spam reply.", opt_out: "Asked not to be contacted again.",
    out_of_office: "Automatic out-of-office reply.",
  }[intent];
}

function nextAction(intent: ReplyIntent): string {
  return {
    interested: "Send the signup link today.", pricing: "Answer pricing (free to start) and share the link.", question: "Answer the question, then offer the link.",
    demo_request: "Propose two times for a 10-minute call.", signup_intent: "Send the link and offer help setting up.", not_interested: "Thank them and close.",
    competitor: "Acknowledge, mention one thing beyond bookings, invite a look.", maybe_later: "Schedule a follow-up in 2 weeks.",
    wrong_person: "Thank them and close.", spam: "Ignore.", opt_out: "Do not contact.", out_of_office: "No action — follow-ups were pushed back a week.",
  }[intent];
}

// ── Reply assistant ────────────────────────────────────────────────────────
export const replyOutput = z.object({ body: z.string().min(2).max(1000) });

const REPLY_SYSTEM = `You draft the next reply in a DM conversation between a founder and a small-business owner, about the founder's app.
Casual, warm, brief Nigerian English, like a real person. Answer exactly what they asked. One benefit at most.
Never invent prices, features, numbers, customers or promises that aren't in PRODUCT FACTS. If you don't know, say you'll check.
No "Dear", no "Kindly", no corporate tone, no generic AI phrases.`;

export interface ReplyRequest {
  intent: ReplyIntent;
  conversation: { direction: "inbound" | "outbound"; body: string }[];
  prospect: FactProspect & { id: string; first_name: string | null; status: ProspectStatus; do_not_contact: boolean; accepts_whatsapp_bookings: boolean | null };
  productName: string;
  productFacts: string[];
  link: string | null;
  channel: Channel;
  tone?: string | null;
}

export async function suggestReply(q: AiLogTarget, workspaceId: string, req: ReplyRequest): Promise<TaskResult<z.infer<typeof replyOutput>>> {
  const sheet = buildFacts(req.prospect);
  const res = await runTask(q, workspaceId, {
    task: "reply.suggest",
    input: req,
    output: replyOutput,
    system: REPLY_SYSTEM,
    maxTokens: 400,
    temperature: 0.6,
    buildPrompt: (r) => `ABOUT THE PROSPECT:
${factsBlock(sheet)}

PRODUCT FACTS (${r.productName}):
${r.productFacts.map((f) => `- ${f}`).join("\n")}
${r.link ? `Signup link to share if appropriate: ${r.link}` : ""}

CONVERSATION (oldest first):
${r.conversation.slice(-8).map((m) => `${m.direction === "inbound" ? "THEM" : "US"}: ${m.body}`).join("\n")}

Their latest message was classified as: ${r.intent}.
${r.tone ? `Tone: ${r.tone}.` : ""}
Draft our next reply. Return JSON: { "body": "..." }`,
    validate: (o) => {
      const v = validateMessage({ body: o.body, channel: req.channel, kind: "reply", prospect: req.prospect, context: { workspacePaused: false } });
      const bad = v.issues.filter((i) => ["fake_familiarity", "unverified_social_proof", "placeholder", "ai_language", "corporate", "too_long"].includes(i.code));
      return bad.length ? bad.map((b) => b.message).join(" ") : null;
    },
    fallback: (r) => ({ body: templateReply(r.intent, r.prospect, r.productName, r.link) }),
  });
  return { ...res, output: { ...res.output, body: noDashes(res.output.body) } };
}
