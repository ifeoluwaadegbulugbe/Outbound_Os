import { sql, withSystem, withWorkspace } from "../db";
import { suppressProspects } from "../services/dnc";
import { audit } from "../services/audit";

/**
 * Unsubscribe by token (from the footer link or the List-Unsubscribe header).
 * Immediate and permanent: email suppression entry + prospect DNC + follow-ups
 * cancelled. Idempotent.
 */
export async function processUnsubscribe(token: string): Promise<{ ok: boolean; business?: string }> {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) return { ok: false };
  const m = await withSystem((q) => q.maybe<{ id: string; workspace_id: string; prospect_id: string; to_email: string | null; sender_account_id: string | null }>(sql`
    select id, workspace_id, prospect_id, to_email, sender_account_id from outreach_messages where unsubscribe_token = ${token}`));
  if (!m) return { ok: false };
  const business = await withWorkspace({ workspaceId: m.workspace_id }, async (q) => {
    const actor = { workspaceId: m.workspace_id, actorType: "system" as const };
    const already = await q.value<boolean>(sql`select unsubscribed from prospects where id = ${m.prospect_id}`);
    if (!already) {
      if (m.to_email) {
        await q.exec(sql`insert into dnc_entries (workspace_id, kind, value, reason, note, prospect_id)
          values (${m.workspace_id}, 'email', ${m.to_email.toLowerCase()}, 'unsubscribed', 'Unsubscribe link', ${m.prospect_id}) on conflict (workspace_id, kind, value) do nothing`);
      }
      await suppressProspects(q, actor, [m.prospect_id], "unsubscribed", "Clicked unsubscribe");
      await q.exec(sql`update prospects set unsubscribed = true where id = ${m.prospect_id}`);
      await q.exec(sql`insert into email_events (workspace_id, message_id, prospect_id, sender_account_id, type, detail)
        values (${m.workspace_id}, ${m.id}, ${m.prospect_id}, ${m.sender_account_id}, 'unsubscribed', 'Unsubscribe link')`);
      await audit(q, actor, "email.unsubscribed", "prospect", m.prospect_id);
    }
    return q.value<string>(sql`select business_name from prospects where id = ${m.prospect_id}`);
  });
  return { ok: true, business };
}
