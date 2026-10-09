"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { generateDraft } from "@/server/services/outreach";
import { researchProspect } from "@/server/services/research";
import { logInbound } from "@/server/services/inbox";
import { restoreFromDnc } from "@/server/services/dnc";
import { recordConversion } from "@/server/services/conversions";
import { logEvent } from "@/server/services/audit";
import type { ActionResult } from "@/components/ui/dialog";

const uuid = z.string().uuid();

export async function generateOneAction(prospectId: string, channel: string, angle: string | null, campaignId: string | null): Promise<ActionResult> {
  const user = await requireUser("member");
  const r = await generateDraft((fn) => asUser(user, fn), { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId, senderName: user.name }, {
    prospectId: uuid.parse(prospectId), campaignId: campaignId ? uuid.parse(campaignId) : null, channel, angle: angle || null,
  });
  revalidatePath(`/prospects/${prospectId}`);
  if (!r.messageId) return { ok: false, error: `Can't draft a message: ${r.reason}` };
  return { ok: true, message: r.status === "blocked" ? `Draft created but blocked: ${r.reason}` : "Draft ready for review in Outreach" };
}

export async function researchAction(prospectId: string): Promise<ActionResult> {
  const user = await requireUser("member");
  await researchProspect((fn) => asUser(user, fn), user.workspaceId, uuid.parse(prospectId));
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, message: "Research brief updated" };
}

export async function addNoteAction(prospectId: string, body: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const text = z.string().trim().min(1).max(4000).parse(body);
  await asUser(user, async (q) => {
    await q.exec(sql`insert into prospect_notes (workspace_id, prospect_id, user_id, body) values (${user.workspaceId}, ${uuid.parse(prospectId)}, ${user.userId}, ${text})`);
    await logEvent(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, { type: "note.added", prospectId });
  });
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, message: "Note added" };
}

export async function logReplyAction(prospectId: string, channel: string, body: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const text = z.string().trim().min(1, "Paste their reply").max(4000).safeParse(body);
  if (!text.success) return { ok: false, error: text.error.issues[0].message };
  const r = await logInbound((fn) => asUser(user, fn), { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, {
    prospectId: uuid.parse(prospectId), channel: z.enum(["instagram", "tiktok", "whatsapp", "email", "linkedin", "facebook"]).parse(channel), body: text.data,
  });
  revalidatePath(`/prospects/${prospectId}`);
  revalidatePath("/inbox");
  const c = r.classification;
  return {
    ok: true,
    message: c.intent === "opt_out" ? "Opt-out detected — prospect moved to do-not-contact" : `Reply logged · ${c.intent.replace("_", " ")} (${c.confidence}%)`,
    data: { conversationId: r.conversationId },
  };
}

export async function restoreDncAction(prospectId: string): Promise<ActionResult> {
  const user = await requireUser("admin");
  await asUser(user, (q) => restoreFromDnc(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, uuid.parse(prospectId)));
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, message: "Restored — prospect can be contacted again" };
}

export async function manualConversionAction(prospectId: string, type: "signup" | "activated" | "paid", plan?: string): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, (q) => recordConversion(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId },
    { type: z.enum(["signup", "activated", "paid"]).parse(type), plan: plan || null, external_user_id: `manual:${prospectId}:${type}` }, uuid.parse(prospectId)));
  revalidatePath(`/prospects/${prospectId}`);
  return { ok: true, message: `Recorded ${type === "signup" ? "signup" : type}` };
}
