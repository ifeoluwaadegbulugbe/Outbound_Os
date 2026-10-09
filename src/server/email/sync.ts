import { sql, withWorkspace } from "../db";
import { fetchThreadReplies, fetchRecentBounces, ProviderSendError, type InboundMessage, type Run, type SenderAccount } from "./providers";
import { logInbound } from "../services/inbox";
import { suppressProspects } from "../services/dnc";
import { evaluateAccountSafety } from "./send";
import { refreshNextFollowup } from "../services/outreach";

/**
 * Reply & bounce sync for a connected mailbox (Gmail/Outlook do not push
 * delivery events for personal mailboxes, so we poll our own threads).
 * - Bounces (mailer-daemon / DSN) → delivery_status bounced, suppression, safety check.
 * - Auto-replies (out of office) → logged, follow-ups postponed, sequence kept.
 * - Real replies → classified (opt-outs first, deterministically) via logInbound.
 * - "Delivered" is PRESUMED after 48h without a bounce and labelled as such.
 */

/** Drop quoted history so classification sees only what they wrote. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (const l of lines) {
    if (/^On .+wrote:$/i.test(l.trim()) || /^-{2,}\s*Original Message/i.test(l) || /^From: .+/i.test(l) && out.length > 0) break;
    if (l.trim().startsWith(">")) continue;
    out.push(l);
  }
  return out.join("\n").trim().slice(0, 4000);
}

export async function processInbound(run: Run, workspaceId: string, accountId: string, m: InboundMessage): Promise<"bounce" | "auto_reply" | "reply" | "duplicate" | "unmatched"> {
  const eventKey = `in:${m.providerId}`;
  const seen = await run((q) => q.value<boolean>(sql`select exists(select 1 from email_events where provider_event_id = ${eventKey})`));
  if (seen) return "duplicate";
  const msg = await run((q) => q.maybe<{ id: string; prospect_id: string; to_email: string | null }>(m.bouncedRecipient
    ? sql`select id, prospect_id, to_email from outreach_messages where sender_account_id = ${accountId} and status = 'sent' and lower(to_email) = ${m.bouncedRecipient} order by sent_at desc limit 1`
    : sql`select id, prospect_id, to_email from outreach_messages where sender_account_id = ${accountId} and status = 'sent' and provider_thread_id = ${m.threadId} order by sent_at desc limit 1`));
  if (!msg) {
    await run((q) => q.exec(sql`insert into email_events (workspace_id, sender_account_id, type, provider_event_id, detail) values (${workspaceId}, ${accountId}, ${m.isBounce ? "bounced" : "replied"}, ${eventKey}, 'Unmatched inbound message') on conflict do nothing`));
    return "unmatched";
  }
  if (m.isBounce) {
    await run(async (q) => {
      await q.exec(sql`update outreach_messages set delivery_status = 'bounced', bounced_at = ${m.receivedAt}, bounce_type = ${/5\.\d\.\d|permanent|does not exist|no such user|user unknown/i.test(m.text) ? "hard" : "soft"} where id = ${msg.id}`);
      await q.exec(sql`insert into email_events (workspace_id, message_id, prospect_id, sender_account_id, type, provider_event_id, detail, occurred_at)
        values (${workspaceId}, ${msg.id}, ${msg.prospect_id}, ${accountId}, 'bounced', ${eventKey}, ${m.subject.slice(0, 200)}, ${m.receivedAt}) on conflict do nothing`);
      await q.exec(sql`update prospects set bounced = true, email_status = 'invalid' where id = ${msg.prospect_id}`);
      if (msg.to_email) {
        await q.exec(sql`insert into dnc_entries (workspace_id, kind, value, reason, note, prospect_id) values (${workspaceId}, 'email', ${msg.to_email.toLowerCase()}, 'bounced', 'Hard/soft bounce', ${msg.prospect_id})
          on conflict (workspace_id, kind, value) do nothing`);
      }
      await q.exec(sql`update followups set status = 'cancelled', cancel_reason = 'bounced' where prospect_id = ${msg.prospect_id} and status = 'pending' and channel = 'email'`);
      await refreshNextFollowup(q, msg.prospect_id);
      await evaluateAccountSafety(q, workspaceId, accountId);
    });
    return "bounce";
  }
  if (m.isAutoReply) {
    await run(async (q) => {
      await q.exec(sql`insert into email_events (workspace_id, message_id, prospect_id, sender_account_id, type, provider_event_id, detail, occurred_at)
        values (${workspaceId}, ${msg.id}, ${msg.prospect_id}, ${accountId}, 'replied', ${eventKey}, 'Auto-reply (out of office)', ${m.receivedAt}) on conflict do nothing`);
      const conv = await q.maybe<{ id: string }>(sql`select id from conversations where prospect_id = ${msg.prospect_id} and channel = 'email'`);
      if (conv) await q.exec(sql`insert into conversation_messages (workspace_id, conversation_id, direction, body, occurred_at, classification)
        values (${workspaceId}, ${conv.id}, 'inbound', ${stripQuoted(m.text) || m.subject}, ${m.receivedAt}, '{"intent":"out_of_office","confidence":95,"source":"rules"}'::jsonb)`);
      await q.exec(sql`update followups set due_at = due_at + interval '7 days' where prospect_id = ${msg.prospect_id} and status = 'pending'`);
      await refreshNextFollowup(q, msg.prospect_id);
    });
    return "auto_reply";
  }
  await run((q) => q.exec(sql`insert into email_events (workspace_id, message_id, prospect_id, sender_account_id, type, provider_event_id, detail, occurred_at)
    values (${workspaceId}, ${msg.id}, ${msg.prospect_id}, ${accountId}, 'replied', ${eventKey}, ${m.subject.slice(0, 200)}, ${m.receivedAt}) on conflict do nothing`));
  await logInbound(run, { workspaceId, actorType: "system" }, { prospectId: msg.prospect_id, channel: "email", body: stripQuoted(m.text) || m.subject, occurredAt: m.receivedAt });
  return "reply";
}

export async function syncAccount(workspaceId: string, accountId: string): Promise<{ replies: number; bounces: number; autoReplies: number; presumedDelivered: number; error?: string }> {
  const run: Run = (fn) => withWorkspace({ workspaceId }, fn);
  const a = await run((q) => q.maybe<SenderAccount & { last_synced_at: Date | null; status: string }>(sql`
    select id, workspace_id, provider, email_address, from_name, secret_ciphertext, last_synced_at, status from sender_accounts where id = ${accountId}`));
  const res = { replies: 0, bounces: 0, autoReplies: 0, presumedDelivered: 0 };
  if (!a || (a.provider !== "gmail" && a.provider !== "microsoft")) return res;
  const since = a.last_synced_at ? new Date(new Date(a.last_synced_at).getTime() - 10 * 60_000) : new Date(Date.now() - 30 * 86_400_000);
  const startedAt = new Date();
  try {
    const threads = await run((q) => q.many<{ provider_thread_id: string }>(sql`
      select distinct provider_thread_id from outreach_messages where sender_account_id = ${accountId} and status = 'sent' and provider_thread_id is not null
        and sent_at > now() - interval '30 days' limit 300`));
    const inbound = [
      ...(await fetchThreadReplies(run, a, threads.map((t) => t.provider_thread_id), since)),
      ...(await fetchRecentBounces(run, a, since)),
    ];
    for (const m of inbound) {
      const r = await processInbound(run, workspaceId, accountId, m);
      if (r === "reply") res.replies++;
      if (r === "bounce") res.bounces++;
      if (r === "auto_reply") res.autoReplies++;
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await run((q) => q.exec(sql`update sender_accounts set last_error = ${msg.slice(0, 500)}, last_error_at = now(),
      status = case when ${e instanceof ProviderSendError && e.kind === "auth"} then 'needs_reconnect' else status end where id = ${accountId}`));
    return { ...res, error: msg };
  }
  // Presumed delivery: accepted ≥ 48h ago and no bounce since.
  const delivered = await run((q) => q.many<{ id: string }>(sql`
    update outreach_messages set delivery_status = 'delivered', delivered_at = now()
    where sender_account_id = ${accountId} and status = 'sent' and delivery_status = 'accepted' and sent_at < now() - interval '48 hours'
    returning id`));
  res.presumedDelivered = delivered.length;
  await run((q) => q.exec(sql`update sender_accounts set last_synced_at = ${startedAt} where id = ${accountId}`));
  return res;
}

export { suppressProspects };
