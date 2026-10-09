import { sql, json, type Q } from "../db";

export interface ActorCtx {
  workspaceId: string;
  actorType: "user" | "system" | "ai" | "webhook";
  actorId?: string | null;
}

/** Append to the audit log. Call inside the same transaction as the change. */
export async function audit(
  q: Q,
  ctx: ActorCtx,
  action: string,
  entityType?: string | null,
  entityId?: string | null,
  data?: Record<string, unknown>,
): Promise<void> {
  await q.exec(sql`
    insert into audit_logs (workspace_id, actor_type, actor_id, action, entity_type, entity_id, data)
    values (${ctx.workspaceId}, ${ctx.actorType}, ${ctx.actorId ?? null}, ${action}, ${entityType ?? null}, ${entityId ?? null}, ${json(data ?? null)})`);
}

/** Outreach/prospect timeline event (also drives analytics). */
export async function logEvent(
  q: Q,
  ctx: ActorCtx,
  e: { type: string; prospectId?: string | null; campaignId?: string | null; messageId?: string | null; channel?: string | null; data?: Record<string, unknown>; at?: Date },
): Promise<void> {
  await q.exec(sql`
    insert into outreach_events (workspace_id, prospect_id, campaign_id, message_id, type, channel, data, actor_type, actor_id, created_at)
    values (${ctx.workspaceId}, ${e.prospectId ?? null}, ${e.campaignId ?? null}, ${e.messageId ?? null}, ${e.type}, ${e.channel ?? null},
            ${json(e.data ?? {})}, ${ctx.actorType}, ${ctx.actorId ?? null}, ${e.at ?? new Date()})`);
}

export async function notify(
  q: Q,
  workspaceId: string,
  n: { type: string; title: string; body?: string; link?: string; userId?: string | null },
): Promise<void> {
  await q.exec(sql`
    insert into notifications (workspace_id, user_id, type, title, body, link)
    values (${workspaceId}, ${n.userId ?? null}, ${n.type}, ${n.title}, ${n.body ?? null}, ${n.link ?? null})`);
}
