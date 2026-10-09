import { sql, json, type Q } from "../db";
import { classifyReply, type Classification } from "../ai/tasks/replies";
import { statusForIntent, needsResponse, type ReplyIntent } from "../domain/classifier";
import { canTransition } from "../domain/status";
import type { ProspectStatus } from "../domain/taxonomy";
import { suppressProspects } from "./dnc";
import { cancelFollowups, refreshNextFollowup } from "./outreach";
import { audit, logEvent, notify, type ActorCtx } from "./audit";

/**
 * Record an inbound reply (pasted by the user from Instagram/TikTok/WhatsApp,
 * or delivered by a permitted API later), classify it, and apply the
 * consequences: status change, opt-out suppression, stop follow-ups, notify.
 * Classification happens before the write transaction (AI latency).
 */
export async function logInbound(
  ws: <T>(fn: (q: Q) => Promise<T>) => Promise<T>,
  actor: ActorCtx,
  input: { prospectId: string; channel: string; body: string; occurredAt?: Date },
): Promise<{ conversationId: string; classification: Classification }> {
  const prev = await ws((q) => q.maybe<{ body: string; business_name: string }>(sql`
    select m.body, p.business_name from conversation_messages m join conversations c on c.id = m.conversation_id join prospects p on p.id = c.prospect_id
    where c.prospect_id = ${input.prospectId} and m.direction = 'outbound' order by m.occurred_at desc limit 1`));
  const classification = await classifyReply({ ws }, actor.workspaceId, input.body, prev?.body ?? null);
  const at = input.occurredAt ?? new Date();

  const conversationId = await ws(async (q) => {
    const p = await q.one<{ status: ProspectStatus; business_name: string; signed_up: boolean }>(sql`select status, business_name, signed_up from prospects where id = ${input.prospectId}`);
    const convId = await q.value<string>(sql`
      insert into conversations (workspace_id, prospect_id, channel, status, last_message_at, last_inbound_at)
      values (${actor.workspaceId}, ${input.prospectId}, ${input.channel}, 'needs_response', ${at}, ${at})
      on conflict (prospect_id, channel) do update set last_message_at = excluded.last_message_at, last_inbound_at = excluded.last_inbound_at
      returning id`);
    await q.exec(sql`insert into conversation_messages (workspace_id, conversation_id, direction, body, occurred_at, classification, logged_by)
      values (${actor.workspaceId}, ${convId}, 'inbound', ${input.body}, ${at}, ${json(classification)}, ${actor.actorType === "user" ? (actor.actorId ?? null) : null})`);
    const intent = classification.intent as ReplyIntent;
    const positive = ["interested", "pricing", "demo_request", "signup_intent"].includes(intent);
    await q.exec(sql`
      update conversations set intent = ${intent}, intent_confidence = ${classification.confidence}, summary = ${classification.summary}, next_action = ${classification.next_action},
        status = ${needsResponse(intent) ? "needs_response" : "closed"}, unread = ${needsResponse(intent)}, priority = ${positive ? "high" : "normal"}
      where id = ${convId}`);
    await q.exec(sql`update prospects set replied_at = coalesce(replied_at, ${at}),
                     interested_at = case when ${positive} then coalesce(interested_at, ${at}) else interested_at end where id = ${input.prospectId}`);
    await logEvent(q, actor, { type: "reply.received", prospectId: input.prospectId, channel: input.channel, at });
    await logEvent(q, { ...actor, actorType: classification.source.startsWith("ai:") ? "ai" : "system" }, { type: "reply.classified", prospectId: input.prospectId, channel: input.channel, data: { intent, confidence: classification.confidence, source: classification.source } });

    // Any reply stops the automated sequence — a human takes over.
    await cancelFollowups(q, input.prospectId, `replied:${intent}`);

    if (intent === "opt_out") {
      await suppressProspects(q, actor, [input.prospectId], "opt_out", `Reply: "${input.body.slice(0, 120)}"`);
    } else {
      const target = statusForIntent(intent);
      if (!p.signed_up && canTransition(p.status, target).ok) {
        await q.exec(sql`update prospects set status = ${target} where id = ${input.prospectId}`);
        await logEvent(q, actor, { type: "status.changed", prospectId: input.prospectId, data: { from: p.status, to: target } });
      } else if (!p.signed_up && canTransition(p.status, "REPLIED").ok) {
        await q.exec(sql`update prospects set status = 'REPLIED' where id = ${input.prospectId}`);
      }
      if (intent === "maybe_later") {
        await q.exec(sql`insert into followups (workspace_id, prospect_id, step, channel, due_at) values (${actor.workspaceId}, ${input.prospectId}, 9, ${input.channel}, ${new Date(at.getTime() + 14 * 86_400_000)})`);
        await refreshNextFollowup(q, input.prospectId);
      }
    }
    await notify(q, actor.workspaceId, {
      type: positive ? "interested" : "reply",
      title: positive ? `🔥 ${p.business_name} is interested` : `${p.business_name} replied`,
      body: `${classification.summary} (${intent.replace("_", " ")}, ${classification.confidence}%)`,
      link: `/inbox?c=${convId}`,
    });
    await audit(q, actor, "reply.logged", "prospect", input.prospectId, { intent });
    return convId;
  });
  return { conversationId, classification };
}

/** Log our outbound reply in an existing conversation (after the human sent it). */
export async function logOutboundReply(q: Q, actor: ActorCtx, conversationId: string, body: string): Promise<void> {
  const conv = await q.one<{ prospect_id: string; channel: string }>(sql`select prospect_id, channel from conversations where id = ${conversationId}`);
  await q.exec(sql`insert into conversation_messages (workspace_id, conversation_id, direction, body, logged_by) values (${actor.workspaceId}, ${conversationId}, 'outbound', ${body}, ${actor.actorId ?? null})`);
  await q.exec(sql`update conversations set status = 'waiting', unread = false, last_message_at = now() where id = ${conversationId}`);
  await q.exec(sql`insert into outreach_messages (workspace_id, prospect_id, channel, kind, body, original_body, generator, status, validation, send_mode, sent_at, sent_by, approved_by, approved_at)
    values (${actor.workspaceId}, ${conv.prospect_id}, ${conv.channel}, 'reply', ${body}, ${body}, 'human', 'sent', '{"ok":true,"issues":[]}'::jsonb, 'assisted', now(), ${actor.actorId ?? null}, ${actor.actorId ?? null}, now())`);
  await q.exec(sql`update prospects set last_contacted_at = now(), last_channel = ${conv.channel} where id = ${conv.prospect_id}`);
  await logEvent(q, actor, { type: "message.sent", prospectId: conv.prospect_id, channel: conv.channel, data: { kind: "reply" } });
}
