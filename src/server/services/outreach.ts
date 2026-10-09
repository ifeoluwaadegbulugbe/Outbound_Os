import { sql, json, textArray, type Q } from "../db";
import { validateMessage, type CampaignConstraints, type ValidationResult } from "../domain/validator";
import { CHANNEL_SPECS, pickChannel, effectiveDailyCap, type ContactTarget } from "../domain/channels";
import { canTransition } from "../domain/status";
import type { Channel, ProspectStatus } from "../domain/taxonomy";
import { generateMessage, type MessageProspect } from "../ai/tasks/message";
import { valuePropsFor } from "./scoring-service";
import { audit, logEvent, notify, type ActorCtx } from "./audit";
import { createTrackedLink } from "./links";
import { DEFAULT_FOLLOWUP_STEPS } from "./workspace-defaults";

// Email-first: email when the prospect has a usable address, then social channels.
export const DEFAULT_CHANNEL_ORDER: Channel[] = ["email", "instagram", "whatsapp", "tiktok"];

const PROSPECT_COLUMNS = sql`
  p.id, p.business_name, p.owner_name, p.first_name, p.category, p.services, p.city, p.area, p.country, p.bio, p.description,
  p.instagram_handle, p.tiktok_handle, p.follower_count, p.last_post_date, p.posting_frequency, p.booking_url, p.website, p.phone,
  p.whatsapp, p.email, p.linkedin_url, p.facebook_url, p.signals, p.status, p.do_not_contact, p.accepts_whatsapp_bookings,
  p.recommended_message_angle, p.is_demo`;

export type DraftProspect = MessageProspect & ContactTarget & { recommended_message_angle: string | null; is_demo: boolean };

export interface CampaignCtx {
  id: string;
  name: string;
  channels: string[];
  tone: string | null;
  offer: string | null;
  instructions: string | null;
  objective: string | null;
  constraints: CampaignConstraints & { includeLinkInitial?: boolean };
  followup_sequence_id: string | null;
}

export interface DraftContext {
  prospect: DraftProspect;
  campaign: CampaignCtx | null;
  variants: { id: string; key: string; angle: string; instructions: string | null }[];
  workspace: { product_name: string; outreach_paused: boolean; product_signup_url: string | null; settings: Record<string, unknown> };
  previousInitial: { sent_at: Date; channel: string } | null;
  pendingFollowup: boolean;
  openDraft: boolean;
}

export async function loadDraftContext(q: Q, prospectId: string, campaignId: string | null): Promise<DraftContext | null> {
  const prospect = await q.maybe<DraftProspect>(sql`select ${PROSPECT_COLUMNS} from prospects p where p.id = ${prospectId} and p.merged_into is null`);
  if (!prospect) return null;
  // Use the given campaign, else the prospect's most recent campaign.
  const campaign = await q.maybe<CampaignCtx>(campaignId
    ? sql`select id, name, channels, tone, offer, instructions, objective, constraints, followup_sequence_id from campaigns where id = ${campaignId}`
    : sql`select c.id, c.name, c.channels, c.tone, c.offer, c.instructions, c.objective, c.constraints, c.followup_sequence_id
          from campaign_prospects cp join campaigns c on c.id = cp.campaign_id where cp.prospect_id = ${prospectId} and c.status <> 'archived'
          order by (c.status = 'active') desc, cp.added_at desc limit 1`);
  const variants = campaign
    ? await q.many<{ id: string; key: string; angle: string; instructions: string | null }>(sql`select id, key, angle, instructions from message_variants where campaign_id = ${campaign.id} and is_active order by key`)
    : [];
  const workspace = await q.one<DraftContext["workspace"]>(sql`select product_name, outreach_paused, product_signup_url, settings from workspaces where id = current_setting('app.workspace_id')::uuid`);
  const previousInitial = await q.maybe<{ sent_at: Date; channel: string }>(sql`select sent_at, channel from outreach_messages where prospect_id = ${prospectId} and kind = 'initial' and status = 'sent' order by sent_at limit 1`);
  const pendingFollowup = await q.value<boolean>(sql`select exists(select 1 from followups where prospect_id = ${prospectId} and status = 'pending')`);
  const openDraft = await q.value<boolean>(sql`select exists(select 1 from outreach_messages where prospect_id = ${prospectId} and status in ('draft','needs_review','approved','scheduled'))`);
  return { prospect, campaign, variants, workspace, previousInitial, pendingFollowup, openDraft };
}

export interface DraftPlan {
  channel: Channel;
  angle: string;
  variantId: string | null;
  valueProps: string[];
}

/** Stable hash → variant, so a prospect always sees the same variant in a campaign. */
function hashPick<T>(items: T[], key: string): T {
  let h = 0;
  for (const c of key) h = (h * 31 + c.charCodeAt(0)) | 0;
  return items[Math.abs(h) % items.length];
}

export function planDraft(ctx: DraftContext, opts: { channel?: string | null; angle?: string | null; kind: "initial" | "followup" }): DraftPlan | { skip: string } {
  const p = ctx.prospect;
  if (opts.kind === "initial" && ctx.previousInitial) return { skip: "already contacted" };
  if (opts.kind === "initial" && ctx.openDraft) return { skip: "already has a draft in the queue" };
  if (p.do_not_contact || p.status === "DO_NOT_CONTACT") return { skip: "do not contact" };
  if (["SIGNED_UP", "ACTIVATED", "PAID"].includes(p.status)) return { skip: "already converted" };
  const order = opts.channel && opts.channel !== "auto" ? [opts.channel] : ctx.campaign?.channels?.length ? ctx.campaign.channels : DEFAULT_CHANNEL_ORDER;
  const channel = pickChannel(order, p);
  if (!channel) return { skip: opts.channel && opts.channel !== "auto" ? `no ${opts.channel} contact` : "no contact channel" };
  let angle = opts.angle ?? p.recommended_message_angle ?? "curiosity";
  let variantId: string | null = null;
  if (!opts.angle && ctx.variants.length) {
    const v = hashPick(ctx.variants, p.id);
    angle = v.angle;
    variantId = v.id;
  }
  return { channel, angle, variantId, valueProps: valuePropsFor(p.category).slice(0, 2) };
}

export function validationFor(ctx: DraftContext, body: string, subject: string | null, channel: Channel, kind: "initial" | "followup" | "reply"): ValidationResult {
  return validateMessage({
    body, subject, channel, kind,
    prospect: { ...ctx.prospect },
    context: {
      workspacePaused: ctx.workspace.outreach_paused,
      previousInitialSentAt: ctx.previousInitial?.sent_at ?? null,
      previousInitialChannel: ctx.previousInitial?.channel ?? null,
      hasPendingFollowup: kind === "initial" ? ctx.pendingFollowup : false,
      verifiedProof: (ctx.workspace.settings.verifiedProof as string[] | undefined) ?? [],
    },
    constraints: ctx.campaign?.constraints,
  });
}

/**
 * Generate one draft end-to-end. Reads in one transaction, calls the AI
 * outside any transaction, writes in another.
 */
export async function generateDraft(
  ws: <T>(fn: (q: Q) => Promise<T>) => Promise<T>,
  actor: ActorCtx & { senderName: string | null },
  input: { prospectId: string; campaignId: string | null; channel?: string | null; angle?: string | null; batchId?: string | null; kind?: "initial" | "followup"; step?: number; followupId?: string | null; followupInstructions?: string | null },
): Promise<{ messageId: string | null; status: "needs_review" | "blocked" | "skipped"; reason?: string }> {
  const kind = input.kind ?? "initial";
  const ctx = await ws((q) => loadDraftContext(q, input.prospectId, input.campaignId));
  if (!ctx) return { messageId: null, status: "skipped", reason: "prospect not found" };
  if (kind === "followup" && ctx.openDraft) return { messageId: null, status: "skipped", reason: "already has a draft in the queue" };
  const plan = planDraft(ctx, { channel: input.channel, angle: input.angle, kind });
  if ("skip" in plan) return { messageId: null, status: "skipped", reason: plan.skip };

  const includeLink = kind === "followup" ? (input.step ?? 1) >= 2 : Boolean(ctx.campaign?.constraints?.includeLinkInitial);
  const linkCode = includeLink ? await ws((q) => createTrackedLink(q, { workspaceId: actor.workspaceId, prospectId: ctx.prospect.id, campaignId: ctx.campaign?.id ?? null, variantId: plan.variantId, channel: plan.channel, destination: ctx.workspace.product_signup_url })) : null;

  const gen = await generateMessage({ ws }, actor.workspaceId, {
    prospect: ctx.prospect,
    channel: plan.channel,
    angle: plan.angle,
    kind,
    step: input.step,
    productName: ctx.workspace.product_name,
    campaign: ctx.campaign ? { tone: ctx.campaign.tone, offer: ctx.campaign.offer, instructions: ctx.campaign.instructions, constraints: ctx.campaign.constraints ?? {}, objective: ctx.campaign.objective } : null,
    valueProps: plan.valueProps,
    senderName: actor.senderName,
    link: linkCode?.url ?? null,
    followupInstructions: input.followupInstructions,
  });

  return ws(async (q) => {
    // Re-check eligibility at write time (things may have changed during generation).
    const fresh = await loadDraftContext(q, input.prospectId, input.campaignId);
    if (!fresh) return { messageId: null, status: "skipped" as const, reason: "prospect not found" };
    const v = validationFor(fresh, gen.output.body, gen.output.subject, plan.channel, kind);
    const status = v.ok ? "needs_review" : "blocked";
    const generator = gen.usedFallback ? "template" : gen.source;
    const id = await q.value<string>(sql`
      insert into outreach_messages (workspace_id, prospect_id, campaign_id, batch_id, channel, kind, step, variant_id, angle, value_props, subject, body, original_body,
                                     generator, status, validation, send_mode, tracked_link_id)
      values (${actor.workspaceId}, ${input.prospectId}, ${fresh.campaign?.id ?? null}, ${input.batchId ?? null}, ${plan.channel}, ${kind}, ${input.step ?? 0},
              ${plan.variantId}, ${plan.angle}, ${textArray(plan.valueProps)}, ${gen.output.subject}, ${gen.output.body}, ${gen.output.body},
              ${generator}, ${status}, ${json(v)}, ${CHANNEL_SPECS[plan.channel].mode}, ${linkCode?.id ?? null})
      returning id`);
    if (input.followupId) await q.exec(sql`update followups set message_id = ${id} where id = ${input.followupId}`);
    if (kind === "initial" && v.ok && ["NEW", "RESEARCHING", "QUALIFIED"].includes(fresh.prospect.status)) {
      await q.exec(sql`update prospects set status = 'READY' where id = ${input.prospectId}`);
    }
    await logEvent(q, actor, { type: v.ok ? "message.generated" : "message.blocked", prospectId: input.prospectId, campaignId: fresh.campaign?.id, messageId: id, channel: plan.channel, data: { generator, reason: v.ok ? undefined : v.issues.find((i) => i.severity === "block")?.message } });
    return { messageId: id, status, reason: v.ok ? undefined : v.issues.find((i) => i.severity === "block")?.message };
  });
}

// ── Review actions ─────────────────────────────────────────────────────────

interface MessageRow {
  id: string;
  prospect_id: string;
  campaign_id: string | null;
  channel: Channel;
  kind: "initial" | "followup" | "reply";
  step: number;
  body: string;
  subject: string | null;
  status: string;
  original_body: string | null;
  sender_account_id: string | null;
  tracked_link_id: string | null;
}

async function loadMessage(q: Q, id: string): Promise<MessageRow> {
  return q.one<MessageRow>(sql`select id, prospect_id, campaign_id, channel, kind, step, body, subject, status, original_body, sender_account_id, tracked_link_id from outreach_messages where id = ${id}`);
}

export async function revalidate(q: Q, id: string): Promise<{ msg: MessageRow; v: ValidationResult; ctx: DraftContext }> {
  const msg = await loadMessage(q, id);
  const ctx = (await loadDraftContext(q, msg.prospect_id, msg.campaign_id))!;
  // For the message itself, "open draft" is this message — not a conflict.
  const v = validationFor({ ...ctx, openDraft: false }, msg.body, msg.subject, msg.channel, msg.kind);
  return { msg, v, ctx };
}

export async function editMessage(q: Q, actor: ActorCtx, id: string, body: string, subject: string | null): Promise<ValidationResult> {
  const msg = await loadMessage(q, id);
  if (msg.status === "sent") throw new Error("Sent messages can't be edited.");
  await q.exec(sql`update outreach_messages set body = ${body}, subject = ${subject}, edited = (original_body is distinct from ${body}), status = 'needs_review' where id = ${id}`);
  const { v } = await revalidate(q, id);
  await q.exec(sql`update outreach_messages set validation = ${json(v)}, status = ${v.ok ? "needs_review" : "blocked"} where id = ${id}`);
  await logEvent(q, actor, { type: "message.edited", prospectId: msg.prospect_id, messageId: id, campaignId: msg.campaign_id });
  return v;
}

export async function approveMessages(q: Q, actor: ActorCtx, ids: string[]): Promise<{ approved: number; blocked: { id: string; reason: string }[] }> {
  const blocked: { id: string; reason: string }[] = [];
  let approved = 0;
  for (const id of ids) {
    const { msg, v } = await revalidate(q, id);
    if (!["needs_review", "draft", "blocked"].includes(msg.status)) continue;
    if (!v.ok) {
      await q.exec(sql`update outreach_messages set status = 'blocked', validation = ${json(v)} where id = ${id}`);
      blocked.push({ id, reason: v.issues.find((i) => i.severity === "block")?.message ?? "Failed validation" });
      continue;
    }
    await q.exec(sql`update outreach_messages set status = 'approved', validation = ${json(v)}, approved_by = ${actor.actorId ?? null}, approved_at = now() where id = ${id}`);
    await q.exec(sql`update prospects set status = 'APPROVED' where id = ${msg.prospect_id} and status in ('QUALIFIED','READY','NEW')`);
    await logEvent(q, actor, { type: "message.approved", prospectId: msg.prospect_id, messageId: id, campaignId: msg.campaign_id, channel: msg.channel });
    approved++;
  }
  if (approved) await audit(q, actor, "messages.approved", "outreach_message", ids.length === 1 ? ids[0] : null, { count: approved });
  return { approved, blocked };
}

export async function rejectMessages(q: Q, actor: ActorCtx, ids: string[], status: "rejected" | "skipped" = "rejected"): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const msg = await loadMessage(q, id);
    if (msg.status === "sent") continue;
    await q.exec(sql`update outreach_messages set status = ${status} where id = ${id}`);
    await q.exec(sql`update prospects set status = 'QUALIFIED' where id = ${msg.prospect_id} and status in ('READY','APPROVED')`);
    if (msg.kind === "followup") await q.exec(sql`update followups set status = 'skipped', completed_at = now() where message_id = ${id} and status = 'pending'`);
    await logEvent(q, actor, { type: status === "skipped" ? "message.skipped" : "message.rejected", prospectId: msg.prospect_id, messageId: id, campaignId: msg.campaign_id });
    n++;
  }
  return n;
}

export interface SenderUsage {
  id: string;
  channel: string;
  label: string;
  cap: number;
  sentToday: number;
}

export async function senderUsage(q: Q, today = new Date()): Promise<SenderUsage[]> {
  const rows = await q.many<{ id: string; channel: string; label: string; daily_cap: number; warmup_enabled: boolean; warmup_start_cap: number; warmup_step: number; warmup_started_on: Date; sent_today: number }>(sql`
    select a.id, a.channel, a.label, a.daily_cap, a.warmup_enabled, a.warmup_start_cap, a.warmup_step, a.warmup_started_on,
           (select count(*)::int from outreach_messages m where m.sender_account_id = a.id and m.sent_at >= date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos') as sent_today
    from sender_accounts a where a.is_active order by a.channel, a.created_at`);
  return rows.map((r) => ({ id: r.id, channel: r.channel, label: r.label, cap: effectiveDailyCap(r, today), sentToday: r.sent_today }));
}

/**
 * The human sent it in the platform's own app. Record it, enforce the
 * sender's daily cap, start the follow-up sequence.
 */
export async function markSent(q: Q, actor: ActorCtx, id: string, opts: { senderAccountId?: string | null; override?: boolean } = {}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { msg, v, ctx } = await revalidate(q, id);
  if (msg.status === "sent") return { ok: true };
  // Emails are only ever marked sent by the provider path (sendEmailMessage) after the provider confirms.
  if (msg.channel === "email") return { ok: false, error: "Emails are sent from the composer or queue, so they can't be marked sent manually." };
  if (!["approved", "needs_review", "scheduled"].includes(msg.status)) return { ok: false, error: `Message is ${msg.status.replace("_", " ")}.` };
  if (!v.ok) {
    await q.exec(sql`update outreach_messages set status = 'blocked', validation = ${json(v)} where id = ${id}`);
    return { ok: false, error: v.issues.find((i) => i.severity === "block")?.message ?? "Failed validation" };
  }
  // Sender account + daily cap
  const usage = (await senderUsage(q)).filter((s) => s.channel === msg.channel);
  const sender = usage.find((s) => s.id === (opts.senderAccountId ?? msg.sender_account_id)) ?? usage.find((s) => s.sentToday < s.cap) ?? usage[0] ?? null;
  if (sender && sender.sentToday >= sender.cap && !opts.override) {
    return { ok: false, error: `${sender.label} has reached today's cap (${sender.cap}). Raise it in Settings → Sender accounts, or continue tomorrow.` };
  }

  const now = new Date();
  await q.exec(sql`update outreach_messages set status = 'sent', sent_at = ${now}, sent_by = ${actor.actorId ?? null}, sender_account_id = ${sender?.id ?? null},
                   approved_at = coalesce(approved_at, ${now}), approved_by = coalesce(approved_by, ${actor.actorId ?? null}) where id = ${id}`);
  await applySentEffects(q, actor, ctx, msg, sender?.label ?? null, now, "message.marked_sent");
  return { ok: true };
}

/**
 * Everything that happens once a message has really gone out (manually in an
 * app, or confirmed by an email provider): prospect contacted, conversation
 * thread, follow-up sequence, timeline event, audit.
 */
export async function applySentEffects(
  q: Q, actor: ActorCtx, ctx: DraftContext,
  msg: { id: string; prospect_id: string; campaign_id: string | null; channel: Channel; kind: string; step: number; body: string },
  senderLabel: string | null, now: Date, auditAction: string,
): Promise<void> {
  const id = msg.id;
  const p = ctx.prospect;
  const nextStatus: ProspectStatus = msg.kind === "followup" ? "FOLLOW_UP" : "CONTACTED";
  const canMove = canTransition(p.status as ProspectStatus, nextStatus).ok || ["CONTACTED", "FOLLOW_UP"].includes(p.status);
  if (msg.kind !== "reply") {
    await q.exec(sql`
      update prospects set first_contacted_at = coalesce(first_contacted_at, ${now}), last_contacted_at = ${now}, contact_count = contact_count + 1,
        last_channel = ${msg.channel}, status = case when ${canMove} and status not in ('REPLIED','INTERESTED','DEMO') then ${nextStatus} else status end
      where id = ${p.id}`);
  }
  const convId = await q.value<string>(sql`
    insert into conversations (workspace_id, prospect_id, campaign_id, channel, status, last_message_at)
    values (${actor.workspaceId}, ${p.id}, ${msg.campaign_id}, ${msg.channel}, 'waiting', ${now})
    on conflict (prospect_id, channel) do update set last_message_at = excluded.last_message_at,
      status = case when conversations.status = 'needs_response' then 'waiting' else conversations.status end
    returning id`);
  await q.exec(sql`insert into conversation_messages (workspace_id, conversation_id, direction, body, occurred_at, outreach_message_id, logged_by)
                   values (${actor.workspaceId}, ${convId}, 'outbound', ${msg.body}, ${now}, ${id}, ${actor.actorId ?? null})`);
  if (msg.kind === "initial") {
    const days = ctx.campaign ? await q.value<number[] | null>(sql`select followup_days from campaigns where id = ${ctx.campaign.id}`) : null;
    await scheduleSequence(q, actor.workspaceId, p.id, msg.campaign_id, ctx.campaign?.followup_sequence_id ?? null, msg.channel, now, days);
  }
  if (msg.kind === "followup") {
    await q.exec(sql`update followups set status = 'done', completed_at = ${now}, message_id = coalesce(message_id, ${id}) where prospect_id = ${p.id} and status = 'pending' and (message_id = ${id} or step = ${msg.step})`);
  }
  await refreshNextFollowup(q, p.id);
  await logEvent(q, actor, { type: "message.sent", prospectId: p.id, messageId: id, campaignId: msg.campaign_id, channel: msg.channel, data: { kind: msg.kind, step: msg.step, sender: senderLabel ?? undefined } });
  await audit(q, actor, auditAction, "outreach_message", id, { channel: msg.channel, sender: senderLabel });
}

export async function scheduleSequence(q: Q, workspaceId: string, prospectId: string, campaignId: string | null, sequenceId: string | null, channel: string, from: Date, overrideDays?: number[] | null) {
  const seq = await q.maybe<{ id: string; steps: { day: number; angle: string; instructions?: string }[] }>(sequenceId
    ? sql`select id, steps from followup_sequences where id = ${sequenceId}`
    : sql`select id, steps from followup_sequences where is_default order by created_at limit 1`);
  const baseSteps = seq?.steps?.length ? seq.steps : DEFAULT_FOLLOWUP_STEPS;
  // Campaign-level delays override the sequence's days (angles/instructions kept by position).
  const steps = overrideDays?.length
    ? overrideDays.slice(0, 6).map((day, i) => ({ ...(baseSteps[Math.min(i, baseSteps.length - 1)] ?? DEFAULT_FOLLOWUP_STEPS[0]), day }))
    : baseSteps;
  for (let i = 0; i < steps.length; i++) {
    await q.exec(sql`
      insert into followups (workspace_id, prospect_id, campaign_id, sequence_id, step, channel, due_at)
      select ${workspaceId}, ${prospectId}, ${campaignId}, ${seq?.id ?? null}, ${i + 1}, ${channel}, ${new Date(from.getTime() + steps[i].day * 86_400_000)}
      where not exists (select 1 from followups where prospect_id = ${prospectId} and step = ${i + 1} and status in ('pending','done'))`);
  }
}

export async function refreshNextFollowup(q: Q, prospectId: string) {
  await q.exec(sql`update prospects set next_follow_up_at = (select min(due_at) from followups where prospect_id = ${prospectId} and status = 'pending') where id = ${prospectId}`);
}

/** Stop all follow-ups (reply, conversion, opt-out). */
export async function cancelFollowups(q: Q, prospectId: string, reason: string) {
  await q.exec(sql`update followups set status = 'cancelled', cancel_reason = ${reason} where prospect_id = ${prospectId} and status = 'pending'`);
  await q.exec(sql`update outreach_messages set status = 'skipped' where prospect_id = ${prospectId} and kind = 'followup' and status in ('draft','needs_review','approved','scheduled')`);
  await refreshNextFollowup(q, prospectId);
}

export { notify };
