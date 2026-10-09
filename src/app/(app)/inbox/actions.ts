"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { suggestReply } from "@/server/ai/tasks/replies";
import { logInbound, logOutboundReply } from "@/server/services/inbox";
import { createTrackedLink } from "@/server/services/links";
import { validateMessage } from "@/server/domain/validator";
import type { ReplyIntent } from "@/server/domain/classifier";
import type { Channel } from "@/server/domain/taxonomy";
import type { ActionResult } from "@/components/ui/dialog";

const uuid = z.string().uuid();

export async function suggestReplyAction(conversationId: string, tone?: string | null): Promise<{ ok: true; body: string; source: string } | { ok: false; error: string }> {
  const user = await requireUser("member");
  const ctx = await asUser(user, async (q) => {
    const c = await q.maybe<{ prospect_id: string; channel: Channel; intent: string | null; campaign_id: string | null }>(sql`select prospect_id, channel, intent, campaign_id from conversations where id = ${uuid.parse(conversationId)}`);
    if (!c) return null;
    const conversation = await q.many<{ direction: "inbound" | "outbound"; body: string }>(sql`select direction, body from conversation_messages where conversation_id = ${conversationId} order by occurred_at`);
    const prospect = await q.one(sql`
      select id, business_name, owner_name, first_name, category, services, city, area, country, bio, description, instagram_handle, tiktok_handle, follower_count,
             last_post_date, posting_frequency, booking_url, website, phone, whatsapp, email, signals, status, do_not_contact, accepts_whatsapp_bookings
      from prospects where id = ${c.prospect_id}`);
    const ws = await q.one<{ product_name: string; product_signup_url: string | null; settings: { productFacts?: string[] } }>(sql`select product_name, product_signup_url, settings from workspaces where id = ${user.workspaceId}`);
    const wantsLink = ["interested", "pricing", "signup_intent"].includes(c.intent ?? "");
    const link = wantsLink ? await createTrackedLink(q, { workspaceId: user.workspaceId, prospectId: c.prospect_id, campaignId: c.campaign_id, variantId: null, channel: c.channel, destination: ws.product_signup_url }) : null;
    return { c, conversation, prospect, ws, link };
  });
  if (!ctx) return { ok: false, error: "Conversation not found" };
  const productFacts = ctx.ws.settings.productFacts?.length ? ctx.ws.settings.productFacts : [
    `${ctx.ws.product_name} is free to start (no card needed).`,
    "Helps service businesses manage bookings, clients, payments, invoices and reminders in one place.",
    "Clients can book through a personal booking link.",
    "Works on phone and web.",
  ];
  const r = await suggestReply({ ws: (fn) => asUser(user, fn) }, user.workspaceId, {
    intent: (ctx.c.intent ?? "question") as ReplyIntent,
    conversation: ctx.conversation,
    prospect: ctx.prospect as never,
    productName: ctx.ws.product_name,
    productFacts,
    link: ctx.link?.url ?? null,
    channel: ctx.c.channel,
    tone: tone ?? null,
  });
  return { ok: true, body: r.output.body, source: r.usedFallback ? "template" : r.source };
}

export async function sendReplyAction(conversationId: string, body: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const text = z.string().trim().min(1).max(4000).safeParse(body);
  if (!text.success) return { ok: false, error: "Reply is empty" };
  const res = await asUser(user, async (q) => {
    const c = await q.one<{ prospect_id: string; channel: Channel }>(sql`select prospect_id, channel from conversations where id = ${uuid.parse(conversationId)}`);
    const p = await q.one<Record<string, unknown>>(sql`select business_name, owner_name, first_name, category, status, do_not_contact, booking_url, accepts_whatsapp_bookings, follower_count, signals, instagram_handle, tiktok_handle, whatsapp, phone, email from prospects where id = ${c.prospect_id}`);
    const paused = await q.value<boolean>(sql`select outreach_paused from workspaces where id = ${user.workspaceId}`);
    const v = validateMessage({ body: text.data, channel: c.channel, kind: "reply", prospect: p as never, context: { workspacePaused: paused } });
    const blocks = v.issues.filter((i) => i.severity === "block" && i.code !== "channel_unavailable");
    if (blocks.length) return { ok: false as const, error: blocks[0].message };
    await logOutboundReply(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, conversationId, text.data);
    return { ok: true as const };
  });
  revalidatePath("/inbox");
  return res.ok ? { ok: true, message: "Reply logged as sent" } : res;
}

export async function logInboundAction(conversationId: string, body: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const c = await asUser(user, (q) => q.one<{ prospect_id: string; channel: string }>(sql`select prospect_id, channel from conversations where id = ${uuid.parse(conversationId)}`));
  const text = z.string().trim().min(1).max(4000).parse(body);
  const r = await logInbound((fn) => asUser(user, fn), { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, { prospectId: c.prospect_id, channel: c.channel, body: text });
  revalidatePath("/inbox");
  return { ok: true, message: r.classification.intent === "opt_out" ? "Opt-out — moved to do-not-contact" : `Classified as ${r.classification.intent.replace("_", " ")} (${r.classification.confidence}%)` };
}

export async function setConversationStatusAction(conversationId: string, status: "open" | "needs_response" | "waiting" | "closed"): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, (q) => q.exec(sql`update conversations set status = ${status}, unread = false where id = ${uuid.parse(conversationId)}`));
  revalidatePath("/inbox");
  return { ok: true, message: status === "closed" ? "Conversation closed" : "Updated" };
}
