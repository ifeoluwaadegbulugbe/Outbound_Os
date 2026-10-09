import { sql, textArray, type Q } from "../db";
import { audit, logEvent, type ActorCtx } from "./audit";

export type DncReason = "opt_out" | "manual" | "competitor" | "customer" | "invalid" | "closed" | "inappropriate" | "duplicate" | "unsubscribed" | "bounced" | "complaint";

/**
 * Put prospects on the do-not-contact list. Writes suppression entries for
 * every identifier (handles, phone, email, domain) so the business stays
 * suppressed even if rediscovered or re-imported later; cancels pending
 * follow-ups; pulls unsent messages out of the queue.
 */
export async function suppressProspects(q: Q, ctx: ActorCtx, ids: string[], reason: DncReason, note?: string | null): Promise<number> {
  if (!ids.length) return 0;
  const rows = await q.many<{ id: string; status: string; instagram_handle: string | null; tiktok_handle: string | null; phone: string | null; whatsapp: string | null; email: string | null; website_domain: string | null }>(sql`
    select id, status, instagram_handle, tiktok_handle, phone, whatsapp, email, website_domain from prospects where id = any(${textArray(ids)}::uuid[])`);
  for (const p of rows) {
    const entries: [string, string | null][] = [
      ["prospect", p.id], ["instagram", p.instagram_handle], ["tiktok", p.tiktok_handle], ["phone", p.phone], ["phone", p.whatsapp], ["email", p.email],
      // Domains only for explicit company-level suppression, not personal opt-outs on shared hosts.
      ["domain", reason === "competitor" || reason === "customer" ? p.website_domain : null],
    ];
    for (const [kind, value] of entries) {
      if (!value) continue;
      await q.exec(sql`
        insert into dnc_entries (workspace_id, kind, value, reason, note, prospect_id, created_by)
        values (${ctx.workspaceId}, ${kind}, ${value.toLowerCase()}, ${reason}, ${note ?? null}, ${p.id}, ${ctx.actorType === "user" ? (ctx.actorId ?? null) : null})
        on conflict (workspace_id, kind, value) do nothing`);
    }
    // Converted customers keep their conversion status; everyone else moves to DO_NOT_CONTACT.
    await q.exec(sql`
      update prospects set do_not_contact = true, dnc_reason = ${reason}, dnc_at = now(), next_follow_up_at = null,
        status = case when status in ('SIGNED_UP','ACTIVATED','PAID') then status else 'DO_NOT_CONTACT' end
      where id = ${p.id}`);
    await q.exec(sql`update followups set status = 'cancelled', cancel_reason = ${`do_not_contact:${reason}`} where prospect_id = ${p.id} and status = 'pending'`);
    await q.exec(sql`update outreach_messages set status = 'blocked',
                       validation = jsonb_build_object('ok', false, 'issues', jsonb_build_array(jsonb_build_object('code','not_contactable','severity','block','message','Prospect was added to do-not-contact.')))
                     where prospect_id = ${p.id} and status in ('draft','needs_review','approved','scheduled')`);
    await logEvent(q, ctx, { type: "dnc.added", prospectId: p.id, data: { reason, note: note ?? undefined } });
  }
  await audit(q, ctx, "dnc.added", "prospect", ids.length === 1 ? ids[0] : null, { count: rows.length, reason });
  return rows.length;
}

/** Admin-only restore. Removes suppression entries tied to the prospect. */
export async function restoreFromDnc(q: Q, ctx: ActorCtx, id: string): Promise<void> {
  await q.exec(sql`delete from dnc_entries where prospect_id = ${id}`);
  await q.exec(sql`update prospects set do_not_contact = false, dnc_reason = null, dnc_at = null,
                   status = case when status = 'DO_NOT_CONTACT' then 'QUALIFIED' else status end where id = ${id}`);
  await logEvent(q, ctx, { type: "status.changed", prospectId: id, data: { to: "QUALIFIED", restoredFromDnc: true } });
  await audit(q, ctx, "dnc.restored", "prospect", id);
}
