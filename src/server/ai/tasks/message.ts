import { z } from "zod";
import type { Q } from "../../db";
import { runTask, type TaskResult, type AiLogTarget } from "../run";
import { buildFacts, factsBlock, type FactProspect } from "../facts";
import { MESSAGE_ANGLES, VALUE_PROPS, type Channel, type ProspectStatus } from "../../domain/taxonomy";
import { CHANNEL_SPECS } from "../../domain/channels";
import { templateMessage } from "../../domain/templates";
import { validateMessage, type CampaignConstraints, type ValidationResult } from "../../domain/validator";

export const messageOutput = z.object({
  body: z.string().min(10).max(2000),
  subject: z.string().max(120).nullable(),
  used_facts: z.array(z.string()).max(8),
});
export type MessageOutput = z.infer<typeof messageOutput>;

export interface MessageProspect extends FactProspect {
  id: string;
  first_name: string | null;
  status: ProspectStatus;
  do_not_contact: boolean;
  accepts_whatsapp_bookings: boolean | null;
}

export interface MessageRequest {
  prospect: MessageProspect;
  channel: Channel;
  angle: string;
  kind: "initial" | "followup";
  step?: number;
  productName: string;
  campaign: { tone: string | null; offer: string | null; instructions: string | null; constraints: CampaignConstraints; objective: string | null } | null;
  valueProps: string[];
  senderName: string | null;
  link: string | null;
  followupInstructions?: string | null;
  tone?: string | null;
}

const SYSTEM = `You write short outreach messages from a real person (a Nigerian founder or growth teammate) to small service-business owners.

Voice: casual, warm, human, conversational Nigerian English. Like a real DM, not marketing copy.
Never:
- sound robotic or use generic AI phrases ("I hope this finds you well", "revolutionize", "seamless", "leverage", "elevate", "game-changer", "unlock").
- use "Dear", "Kindly", or corporate jargon. No feature dumps — mention ONE benefit at most.
- pretend to know them, to have used their services, or to have been referred.
- claim anything about them that isn't in KNOWN FACTS. If unsure (e.g. whether they use WhatsApp), ask instead of asserting.
- invent social proof, numbers, prices or testimonials.
Keep it short. At most one emoji, usually none. End with a low-pressure question.`;

export async function generateMessage(q: AiLogTarget, workspaceId: string, req: MessageRequest): Promise<TaskResult<MessageOutput> & { validation: ValidationResult }> {
  const sheet = buildFacts(req.prospect);
  const spec = CHANNEL_SPECS[req.channel];
  const c = req.campaign?.constraints ?? {};
  const maxChars = Math.min(spec.maxChars, c.maxChars ?? spec.idealChars + 60);
  const angle = MESSAGE_ANGLES.find((a) => a.key === req.angle);
  const tpl = templateMessage({
    prospect: req.prospect, angle: req.angle, channel: req.channel, kind: req.kind, step: req.step, productName: req.productName,
    offer: req.campaign?.offer, senderName: req.senderName, link: req.link, noEmojis: c.noEmojis, valueProps: req.valueProps,
  });

  const contentCheck = (body: string, subject: string | null) =>
    validateMessage({
      body, subject, channel: req.channel, kind: req.kind,
      prospect: { ...req.prospect, signals: req.prospect.signals },
      context: { workspacePaused: false },
      constraints: { ...c, maxChars },
    });

  const res = await runTask(q, workspaceId, {
    task: req.kind === "initial" ? "message.generate" : "message.followup",
    input: req,
    output: messageOutput,
    system: SYSTEM,
    maxTokens: 500,
    temperature: 0.7,
    buildPrompt: (r) => `${factsBlock(sheet)}

Write a ${r.kind === "initial" ? "first" : `follow-up #${r.step ?? 1}`} ${spec.label} message from ${r.senderName ?? "the founder"} about ${r.productName}.
Angle: ${angle?.label ?? r.angle} — ${angle?.hint ?? ""}
Lead benefit (pick at most one): ${r.valueProps.map((v) => VALUE_PROPS[v as keyof typeof VALUE_PROPS]?.short ?? v).join(" | ")}
${r.campaign?.objective ? `Objective: ${r.campaign.objective}` : ""}
${r.campaign?.offer ? `Offer: ${r.campaign.offer}` : ""}
${r.campaign?.tone || r.tone ? `Tone: ${r.tone ?? r.campaign?.tone}` : ""}
${r.campaign?.instructions ? `Campaign instructions (follow exactly): ${r.campaign.instructions}` : ""}
${r.followupInstructions ? `Follow-up instructions: ${r.followupInstructions}` : ""}
${c.noEmojis ? "Do not use emojis." : ""}
${r.link ? `Include this link once, as-is: ${r.link}` : "Do not include links."}
${req.channel === "email" ? `Email: write an honest, specific subject (no clickbait, no "Re:", no fake urgency, under 60 characters). Plain text body of 3–6 short lines, sign off as ${r.senderName ?? `the ${r.productName} team`}. Do NOT add an unsubscribe line, address or legal footer — those are appended automatically. Don't force personalisation if the facts don't support it.` : "subject must be null."}
Hard limit: ${maxChars} characters.
Style reference (don't copy, just match the register): "${tpl.body}"

Return JSON: body, subject, used_facts (fact ids you relied on).`,
    validate: (o) => {
      const v = contentCheck(o.body, o.subject);
      const blocks = v.issues.filter((i) => i.severity === "block" && i.code !== "channel_unavailable");
      const aiWarn = v.issues.filter((i) => ["ai_language", "corporate", "unverified_claim", "category_mismatch"].includes(i.code));
      if (blocks.length) return blocks.map((b) => b.message).join(" ");
      if (aiWarn.length) return aiWarn.map((b) => b.message).join(" ");
      return null;
    },
    fallback: () => ({ body: tpl.body, subject: tpl.subject, used_facts: [] }),
  });
  const output = res.usedFallback ? res.output : res.output;
  return { ...res, output, validation: contentCheck(output.body, output.subject) };
}
