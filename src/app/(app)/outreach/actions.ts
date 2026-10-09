"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json } from "@/server/db";
import { enqueue } from "@/server/jobs/queue";
import { matchingIds, parseListParams } from "@/server/repos/prospects";
import { approveMessages, editMessage, generateDraft, markSent, rejectMessages } from "@/server/services/outreach";
import { audit } from "@/server/services/audit";
import type { ActionResult } from "@/components/ui/dialog";
import type { ValidationResult } from "@/server/domain/validator";

const selectionSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(5000) }),
  z.object({ allMatching: z.record(z.string(), z.string()) }),
]);

export async function generateMessagesAction(input: { selection: z.infer<typeof selectionSchema>; channel: string; campaignId: string | null; angle?: string | null }): Promise<ActionResult> {
  const user = await requireUser("member");
  const sel = selectionSchema.parse(input.selection);
  const channel = z.enum(["auto", "instagram", "whatsapp", "tiktok", "email", "linkedin", "facebook"]).parse(input.channel);
  const res = await asUser(user, async (q) => {
    const ids = "ids" in sel ? sel.ids : await matchingIds(q, parseListParams(sel.allMatching), 2000);
    if (!ids.length) return null;
    const batchId = await q.value<string>(sql`
      insert into outreach_batches (workspace_id, campaign_id, channel, total, params, created_by)
      values (${user.workspaceId}, ${input.campaignId}, ${channel}, ${ids.length}, ${json({ angle: input.angle ?? null })}, ${user.userId}) returning id`);
    const jobId = await enqueue(q, {
      workspaceId: user.workspaceId, type: "messages.generate", createdBy: user.userId, total: ids.length, label: "Queued",
      payload: { batchId, prospectIds: ids, channel, campaignId: input.campaignId, angle: input.angle ?? null },
    });
    await q.exec(sql`update outreach_batches set job_id = ${jobId} where id = ${batchId}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "messages.generate_requested", "outreach_batch", batchId, { count: ids.length, channel });
    return { batchId, count: ids.length };
  });
  if (!res) return { ok: false, error: "Nothing selected." };
  revalidatePath("/outreach");
  return { ok: true, message: `Generating ${res.count} drafts — they'll appear in Review as they're ready.`, data: res };
}

export async function editMessageAction(id: string, body: string, subject: string | null): Promise<{ ok: true; validation: ValidationResult } | { ok: false; error: string }> {
  const user = await requireUser("member");
  const text = z.string().trim().min(1, "Message can't be empty").max(4000).safeParse(body);
  if (!text.success) return { ok: false, error: text.error.issues[0].message };
  try {
    const v = await asUser(user, (q) => editMessage(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, z.string().uuid().parse(id), text.data, subject?.trim() || null));
    revalidatePath("/outreach");
    return { ok: true, validation: v };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Couldn't save" };
  }
}

export async function approveAction(ids: string[]): Promise<ActionResult> {
  const user = await requireUser("member");
  const valid = z.array(z.string().uuid()).min(1).max(1000).parse(ids);
  const r = await asUser(user, async (q) => {
    const paused = await q.value<boolean>(sql`select outreach_paused from workspaces where id = ${user.workspaceId}`);
    if (paused) return null;
    return approveMessages(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, valid);
  });
  revalidatePath("/outreach");
  if (!r) return { ok: false, error: "All outreach is paused. Resume it first." };
  if (r.approved === 0 && r.blocked.length) return { ok: false, error: `Blocked: ${r.blocked[0].reason}` };
  return { ok: true, message: `Approved ${r.approved}${r.blocked.length ? ` · ${r.blocked.length} blocked by the safety check` : ""}` };
}

export async function approveAllReadyAction(batchId: string | null): Promise<ActionResult> {
  const user = await requireUser("member");
  const ids = await asUser(user, (q) => q.many<{ id: string }>(batchId
    ? sql`select id from outreach_messages where status = 'needs_review' and batch_id = ${batchId} limit 1000`
    : sql`select id from outreach_messages where status = 'needs_review' and (validation->'issues') = '[]'::jsonb limit 1000`));
  if (!ids.length) return { ok: false, error: "Nothing ready to approve." };
  return approveAction(ids.map((r) => r.id));
}

export async function rejectAction(ids: string[], mode: "rejected" | "skipped" = "rejected"): Promise<ActionResult> {
  const user = await requireUser("member");
  const n = await asUser(user, (q) => rejectMessages(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, z.array(z.string().uuid()).min(1).parse(ids), mode));
  revalidatePath("/outreach");
  return { ok: true, message: `${mode === "skipped" ? "Skipped" : "Rejected"} ${n}` };
}

export async function regenerateAction(id: string, opts: { angle?: string | null; tone?: string | null; channel?: string | null }): Promise<ActionResult> {
  const user = await requireUser("member");
  const old = await asUser(user, (q) => q.maybe<{ prospect_id: string; campaign_id: string | null; channel: string; kind: string; step: number; status: string }>(
    sql`select prospect_id, campaign_id, channel, kind, step, status from outreach_messages where id = ${z.string().uuid().parse(id)}`));
  if (!old) return { ok: false, error: "Message not found" };
  if (old.status === "sent") return { ok: false, error: "Already sent" };
  await asUser(user, (q) => q.exec(sql`update outreach_messages set status = 'rejected' where id = ${id}`));
  const r = await generateDraft((fn) => asUser(user, fn), { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId, senderName: user.name }, {
    prospectId: old.prospect_id, campaignId: old.campaign_id, channel: opts.channel ?? old.channel, angle: opts.angle ?? null,
    kind: old.kind === "followup" ? "followup" : "initial", step: old.step || undefined,
  });
  revalidatePath("/outreach");
  if (!r.messageId) {
    await asUser(user, (q) => q.exec(sql`update outreach_messages set status = 'needs_review' where id = ${id}`));
    return { ok: false, error: `Couldn't regenerate: ${r.reason}` };
  }
  return { ok: true, message: r.status === "blocked" ? `New draft was blocked: ${r.reason}` : "New draft ready", data: { id: r.messageId } };
}

export async function markSentAction(id: string, opts: { senderAccountId?: string | null; override?: boolean } = {}): Promise<ActionResult> {
  const user = await requireUser("member");
  const r = await asUser(user, (q) => markSent(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, z.string().uuid().parse(id), opts));
  revalidatePath("/outreach");
  return r.ok ? { ok: true, message: "Marked as sent · follow-ups scheduled" } : { ok: false, error: r.error };
}

export async function scheduleAction(id: string, when: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const d = new Date(when);
  if (Number.isNaN(d.getTime()) || d.getTime() < Date.now() - 60_000) return { ok: false, error: "Pick a time in the future." };
  await asUser(user, (q) => q.exec(sql`update outreach_messages set status = 'scheduled', scheduled_for = ${d} where id = ${z.string().uuid().parse(id)} and status in ('needs_review','approved')`));
  revalidatePath("/outreach");
  return { ok: true, message: `Scheduled — it'll appear in your send queue then` };
}

export async function cancelBatchAction(batchId: string): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, async (q) => {
    const job = await q.value<string | null>(sql`select job_id from outreach_batches where id = ${z.string().uuid().parse(batchId)}`);
    if (job) await q.exec(sql`update jobs set cancel_requested = true, status = case when status = 'queued' then 'cancelled' else status end where id = ${job}`);
    await q.exec(sql`update outreach_batches set status = 'cancelled' where id = ${batchId} and status in ('queued','generating')`);
  });
  revalidatePath("/outreach");
  return { ok: true, message: "Batch cancelled" };
}
