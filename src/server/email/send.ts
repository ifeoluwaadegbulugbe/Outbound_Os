import { randomBytes } from "node:crypto";
import { sql, json, textArray, withSystem, withWorkspace, type Q } from "../db";
import type { ActorCtx } from "../services/audit";
import { audit, notify } from "../services/audit";
import { applySentEffects, loadDraftContext, revalidate, senderUsage } from "../services/outreach";
import { suppressProspects } from "../services/dnc";
import { effectiveDailyCap } from "../domain/channels";
import { appUrl } from "../services/links";
import { sendEmail, ProviderSendError, testSinkEnabled, type SenderAccount, type Run } from "./providers";
import { footer } from "./mime";
import { getEmailSettings, campaignReadiness, recipientEligibility, type EmailSettings } from "./policy";
import { verifyAndStore } from "./enrich";

/**
 * Real email sending. A message is marked sent ONLY after the provider
 * accepts it. Duplicate sends are impossible: the message is atomically
 * claimed (status → 'sending') before the provider call, and a crash mid-send
 * leaves it 'failed / check Sent folder' rather than re-sending blindly.
 */

export type SendOutcome = { ok: true; providerMessageId: string } | { ok: false; error: string; retryable?: boolean };

interface MsgRow {
  id: string;
  prospect_id: string;
  campaign_id: string | null;
  channel: "email";
  kind: "initial" | "followup" | "reply";
  step: number;
  subject: string | null;
  body: string;
  status: string;
  sender_account_id: string | null;
  provider_thread_id: string | null;
  rfc_message_id: string | null;
}

const ACCOUNT_COLS = sql`id, workspace_id, provider, email_address, from_name, secret_ciphertext, status, daily_cap, warmup_enabled, warmup_start_cap,
  warmup_step, warmup_started_on, provider_daily_limit, min_interval_seconds, last_sent_at, label, paused_reason, paused_at`;

export interface EmailAccountRow extends SenderAccount {
  status: string;
  daily_cap: number;
  warmup_enabled: boolean;
  warmup_start_cap: number;
  warmup_step: number;
  warmup_started_on: Date;
  provider_daily_limit: number | null;
  min_interval_seconds: number;
  last_sent_at: Date | null;
  label: string;
  paused_reason: string | null;
  paused_at: Date | null;
}

export function accountCap(a: EmailAccountRow): number {
  const cap = effectiveDailyCap(a);
  return a.provider_daily_limit ? Math.min(cap, a.provider_daily_limit) : cap;
}

async function sentToday(q: Q, accountId: string): Promise<number> {
  return q.value<number>(sql`select count(*)::int from outreach_messages where sender_account_id = ${accountId} and status = 'sent' and not is_test
    and sent_at >= date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`);
}

/** Mailbox providers that can send here; the dev test sink only where it's enabled (never in production). */
function sendingProviders(): string[] {
  return testSinkEnabled() ? ["gmail", "microsoft", "test_sink"] : ["gmail", "microsoft"];
}

async function pickAccount(q: Q, preferred: (string | null)[]): Promise<EmailAccountRow | null> {
  for (const id of preferred) {
    if (!id) continue;
    const a = await q.maybe<EmailAccountRow>(sql`select ${ACCOUNT_COLS} from sender_accounts where id = ${id} and channel = 'email' and is_active
      and provider = any(${textArray(sendingProviders())})`);
    if (a) return a;
  }
  const all = await q.many<EmailAccountRow>(sql`select ${ACCOUNT_COLS} from sender_accounts
    where channel = 'email' and is_active and provider = any(${textArray(sendingProviders())}) and status = 'active' order by last_sent_at nulls first`);
  for (const a of all) if ((await sentToday(q, a.id)) < accountCap(a)) return a;
  return all[0] ?? null;
}

async function prospectFor(q: Q, id: string) {
  return q.one<{ id: string; email: string | null; email_status: string; country: string | null; do_not_contact: boolean; unsubscribed: boolean; bounced: boolean; status: string; business_name: string }>(sql`
    select id, email, email_status, country, do_not_contact, unsubscribed, bounced, status, business_name from prospects where id = ${id}`);
}

/** All the checks that must pass before an email may go out. */
export async function preflight(q: Q, messageId: string, settings: EmailSettings): Promise<{ ok: true; msg: MsgRow; account: EmailAccountRow; to: string } | { ok: false; error: string; needsVerification?: boolean }> {
  const msg = await q.maybe<MsgRow>(sql`select id, prospect_id, campaign_id, channel, kind, step, subject, body, status, sender_account_id, provider_thread_id, rfc_message_id from outreach_messages where id = ${messageId}`);
  if (!msg) return { ok: false, error: "Message not found" };
  if (msg.channel !== "email") return { ok: false, error: "Not an email message" };
  if (msg.status === "sent") return { ok: false, error: "Already sent" };
  if (msg.status === "sending") return { ok: false, error: "Already being sent" };
  if (!["needs_review", "approved", "queued", "scheduled", "failed"].includes(msg.status)) return { ok: false, error: `Message is ${msg.status.replace("_", " ")}` };
  const paused = await q.value<boolean>(sql`select outreach_paused from workspaces where id = current_setting('app.workspace_id')::uuid`);
  if (paused) return { ok: false, error: "All outreach is paused (top bar → Resume outreach)." };
  const ready = await campaignReadiness(q, msg.campaign_id, settings);
  if (!ready.ready) return { ok: false, error: `Not ready to send: ${ready.missing[0]}` };
  const p = await prospectFor(q, msg.prospect_id);
  const elig = await recipientEligibility(q, p, settings);
  if (elig.needsVerification) return { ok: false, error: "Email not verified yet", needsVerification: true };
  if (!elig.ok) return { ok: false, error: elig.reasons[0] };
  const { v } = await revalidate(q, messageId);
  const blocks = v.issues.filter((i) => i.severity === "block");
  if (blocks.length) return { ok: false, error: blocks[0].message };
  if (!msg.subject?.trim()) return { ok: false, error: "Add a subject line" };
  const campaignAcct = msg.campaign_id ? await q.value<string | null>(sql`select sender_account_id from campaigns where id = ${msg.campaign_id}`) : null;
  const account = await pickAccount(q, [msg.sender_account_id, campaignAcct]);
  if (!account) return { ok: false, error: "No email account connected. Connect Gmail or Outlook in Data Sources → Sending accounts." };
  if (account.status !== "active") return { ok: false, error: `${account.email_address ?? account.label} is ${account.status.replace("_", " ")}${account.paused_reason ? ` — ${account.paused_reason}` : ""}` };
  if (account.provider === "manual") return { ok: false, error: "This account can't send automatically." };
  const used = await sentToday(q, account.id);
  const cap = accountCap(account);
  if (used >= cap) return { ok: false, error: `${account.email_address} reached today's limit (${used}/${cap}). It resumes tomorrow.` };
  // Never send the same initial email twice to one prospect.
  if (msg.kind === "initial") {
    const dup = await q.value<boolean>(sql`select exists(select 1 from outreach_messages where prospect_id = ${msg.prospect_id} and channel = 'email' and kind = 'initial' and status in ('sent','sending') and id <> ${messageId})`);
    if (dup) return { ok: false, error: "This prospect already received a first email." };
  }
  return { ok: true, msg, account, to: p.email!.toLowerCase() };
}

/**
 * Send one email now. `run` opens short workspace transactions.
 * Flow: preflight (+ auto-verify if needed) → atomic claim → provider → record.
 */
export async function sendEmailMessage(run: Run, actor: ActorCtx, messageId: string, opts: { fromQueue?: boolean } = {}): Promise<SendOutcome> {
  const settings = await run((q) => getEmailSettings(q, actor.workspaceId));
  let pre = await run((q) => preflight(q, messageId, settings));
  if (!pre.ok && pre.needsVerification) {
    const pid = await run((q) => q.value<string>(sql`select prospect_id from outreach_messages where id = ${messageId}`));
    await verifyAndStore(run, actor.workspaceId, pid);
    pre = await run((q) => preflight(q, messageId, settings));
  }
  if (!pre.ok) {
    if (opts.fromQueue) await run((q) => q.exec(sql`update outreach_messages set status = 'needs_review', error = ${pre.ok ? null : pre.error} where id = ${messageId} and status = 'queued'`));
    return { ok: false, error: pre.error };
  }
  const { msg, account, to } = pre;
  const token = randomBytes(18).toString("base64url");
  const claimed = await run((q) => q.maybe<{ id: string }>(sql`
    update outreach_messages set status = 'sending', sender_account_id = ${account.id}, to_email = ${to}, provider = ${account.provider},
      idempotency_key = coalesce(idempotency_key, id::text), send_attempts = send_attempts + 1, unsubscribe_token = coalesce(unsubscribe_token, ${token}),
      approved_at = coalesce(approved_at, now()), approved_by = coalesce(approved_by, ${actor.actorType === "user" ? (actor.actorId ?? null) : null})
    where id = ${messageId} and status in ('needs_review','approved','queued','scheduled','failed')
    returning id`));
  if (!claimed) return { ok: false, error: "Already being sent" };
  const unsubToken = await run((q) => q.value<string>(sql`select unsubscribe_token from outreach_messages where id = ${messageId}`));
  const unsubscribeUrl = `${appUrl()}/u/${unsubToken}`;
  // Follow-ups stay in the same thread.
  const parent = msg.kind === "followup"
    ? await run((q) => q.maybe<{ provider_thread_id: string | null; rfc_message_id: string | null; subject: string | null }>(sql`
        select provider_thread_id, rfc_message_id, subject from outreach_messages where prospect_id = ${msg.prospect_id} and channel = 'email' and status = 'sent' and sender_account_id = ${account.id}
        order by sent_at desc limit 1`))
    : null;
  const subject = msg.kind === "followup" && parent?.subject ? `Re: ${parent.subject.replace(/^re:\s*/i, "")}` : msg.subject!;
  const text = msg.body.trimEnd() + "\n" + footer({ senderName: settings.sender.senderName, company: settings.sender.company, address: settings.sender.address }, unsubscribeUrl);

  try {
    const r = await sendEmail(run, account, {
      fromName: account.from_name ?? settings.sender.senderName, fromEmail: account.email_address!, to, subject, text,
      inReplyTo: parent?.rfc_message_id ?? null, unsubscribeUrl, unsubscribeMailto: account.email_address,
    }, parent?.provider_thread_id ?? null);
    await run(async (q) => {
      const now = new Date();
      await q.exec(sql`update outreach_messages set status = 'sent', sent_at = ${now}, sent_by = ${actor.actorType === "user" ? (actor.actorId ?? null) : null},
        provider_message_id = ${r.providerMessageId}, provider_thread_id = ${r.threadId}, rfc_message_id = ${r.rfcMessageId}, delivery_status = 'accepted',
        subject = ${subject}, error = null where id = ${messageId}`);
      await q.exec(sql`update sender_accounts set last_sent_at = ${now}, last_error = null where id = ${account.id}`);
      await q.exec(sql`insert into email_events (workspace_id, message_id, prospect_id, sender_account_id, type, provider, provider_event_id, detail)
        values (${actor.workspaceId}, ${messageId}, ${msg.prospect_id}, ${account.id}, 'accepted', ${account.provider}, ${`send:${r.providerMessageId}`}, ${`Accepted by ${account.provider}`})
        on conflict do nothing`);
      const ctx = (await loadDraftContext(q, msg.prospect_id, msg.campaign_id))!;
      await applySentEffects(q, actor, ctx, { ...msg, subject } as never, account.email_address, now, "email.sent");
    });
    return { ok: true, providerMessageId: r.providerMessageId };
  } catch (e) {
    const err = e instanceof ProviderSendError ? e : new ProviderSendError(e instanceof Error ? e.message : String(e), "transient");
    await run(async (q) => {
      const retry = opts.fromQueue && (err.kind === "transient" || err.kind === "rate_limit");
      const back = retry ? "queued" : err.kind === "invalid_recipient" ? "blocked" : "approved";
      await q.exec(sql`update outreach_messages set status = ${back}, error = ${err.message.slice(0, 500)},
        queued_at = case when ${retry} then now() + interval '10 minutes' else queued_at end where id = ${messageId}`);
      await q.exec(sql`insert into email_events (workspace_id, message_id, prospect_id, sender_account_id, type, provider, detail)
        values (${actor.workspaceId}, ${messageId}, ${msg.prospect_id}, ${account.id}, 'failed', ${account.provider}, ${err.message.slice(0, 500)})`);
      await q.exec(sql`update sender_accounts set last_error = ${err.message.slice(0, 500)}, last_error_at = now() where id = ${account.id}`);
      if (err.kind === "auth") {
        await q.exec(sql`update sender_accounts set status = 'needs_reconnect', paused_reason = 'Authorization expired or revoked' where id = ${account.id}`);
        await notify(q, actor.workspaceId, { type: "account_error", title: `${account.email_address} needs to be reconnected`, body: err.message.slice(0, 200), link: "/integrations#sending" });
      }
      if (err.kind === "quota") {
        await q.exec(sql`update sender_accounts set status = 'paused', paused_reason = 'Daily limit reached (provider)', paused_at = now() where id = ${account.id}`);
        await notify(q, actor.workspaceId, { type: "account_paused", title: `${account.email_address} hit its provider limit — paused until tomorrow`, link: "/integrations#sending" });
      }
      if (err.kind === "invalid_recipient") {
        await q.exec(sql`update prospects set email_status = 'invalid', bounced = true where id = ${msg.prospect_id}`);
        await suppressProspects(q, actor, [msg.prospect_id], "bounced", `Provider rejected recipient: ${err.message.slice(0, 120)}`);
      }
    });
    return { ok: false, error: err.message, retryable: err.kind === "transient" || err.kind === "rate_limit" };
  }
}

/** Send a test copy to yourself/a teammate. Never changes the draft's status. */
export async function sendTestEmail(run: Run, actor: ActorCtx, messageId: string, to: string): Promise<SendOutcome> {
  const settings = await run((q) => getEmailSettings(q, actor.workspaceId));
  const data = await run(async (q) => {
    const msg = await q.maybe<MsgRow>(sql`select id, prospect_id, campaign_id, channel, kind, step, subject, body, status, sender_account_id, provider_thread_id, rfc_message_id from outreach_messages where id = ${messageId}`);
    if (!msg) return null;
    const campaignAcct = msg.campaign_id ? await q.value<string | null>(sql`select sender_account_id from campaigns where id = ${msg.campaign_id}`) : null;
    return { msg, account: await pickAccount(q, [msg.sender_account_id, campaignAcct]) };
  });
  if (!data) return { ok: false, error: "Message not found" };
  if (!data.account || data.account.status !== "active" || data.account.provider === "manual") return { ok: false, error: "Connect an active Gmail or Outlook account first." };
  const text = data.msg.body.trimEnd() + "\n" + footer({ senderName: settings.sender.senderName || "Sender", company: settings.sender.company, address: settings.sender.address }, `${appUrl()}/u/test`);
  try {
    const r = await sendEmail(run, data.account, { fromName: data.account.from_name ?? settings.sender.senderName, fromEmail: data.account.email_address!, to, subject: `[Test] ${data.msg.subject ?? "(no subject)"}`, text });
    await run((q) => q.exec(sql`insert into email_events (workspace_id, message_id, prospect_id, sender_account_id, type, provider, detail)
      values (${actor.workspaceId}, ${messageId}, ${data.msg.prospect_id}, ${data.account!.id}, 'test_sent', ${data.account!.provider}, ${`Test sent to ${to}`})`));
    return { ok: true, providerMessageId: r.providerMessageId };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Approve + place in the controlled sending queue (sent by the dispatcher within limits). */
export async function queueEmails(q: Q, actor: ActorCtx, ids: string[]): Promise<{ queued: number; blocked: { id: string; reason: string }[] }> {
  const settings = await getEmailSettings(q, actor.workspaceId);
  let queued = 0;
  const blocked: { id: string; reason: string }[] = [];
  for (const id of ids) {
    const pre = await preflight(q, id, settings);
    if (!pre.ok && !pre.needsVerification && !/reached today's limit/.test(pre.error)) {
      blocked.push({ id, reason: pre.error });
      continue;
    }
    const r = await q.maybe(sql`update outreach_messages set status = 'queued', queued_at = now(), approved_at = coalesce(approved_at, now()),
      approved_by = coalesce(approved_by, ${actor.actorId ?? null}), error = null where id = ${id} and status in ('needs_review','approved','scheduled','failed') returning id`);
    if (r) queued++;
  }
  if (queued) await audit(q, actor, "email.queued", null, null, { count: queued });
  return { queued, blocked };
}

function withinWindow(now: Date, w: { days?: number[]; start?: string; end?: string; tz?: string } | null): boolean {
  const win = { days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "19:00", tz: "Africa/Lagos", ...(w ?? {}) };
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: win.tz, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(parts.find((p) => p.type === "weekday")!.value);
  const hm = `${parts.find((p) => p.type === "hour")!.value}:${parts.find((p) => p.type === "minute")!.value}`;
  return win.days.includes(day) && hm >= win.start && hm < win.end;
}

/**
 * Sending queue dispatcher. At most one email per account per interval
 * (with jitter), only inside the send window, never over the daily cap,
 * never while paused. Called every ~30s by the worker.
 */
export async function dispatchQueuedEmails(workspaceId: string, now = new Date(), opts: { ignoreWindow?: boolean } = {}): Promise<number> {
  const run: Run = (fn) => withWorkspace({ workspaceId }, fn);
  // Recover sends interrupted by a crash: don't resend blindly.
  await run((q) => q.exec(sql`update outreach_messages set status = 'failed', error = 'Send was interrupted — check your Sent folder before retrying'
    where status = 'sending' and updated_at < now() - interval '10 minutes'`));
  // Lift provider-limit pauses the next day.
  await run((q) => q.exec(sql`update sender_accounts set status = 'active', paused_reason = null
    where status = 'paused' and paused_reason like 'Daily limit%' and paused_at < date_trunc('day', now() at time zone 'Africa/Lagos') at time zone 'Africa/Lagos'`));
  const paused = await run((q) => q.value<boolean>(sql`select outreach_paused from workspaces where id = ${workspaceId}`));
  if (paused) return 0;
  const accounts = await run((q) => q.many<EmailAccountRow>(sql`select ${ACCOUNT_COLS} from sender_accounts where channel = 'email' and is_active and status = 'active' and provider = any(${textArray(sendingProviders())})`));
  let sent = 0;
  for (const a of accounts) {
    const jitter = 1 + Math.random() * 0.5;
    if (a.last_sent_at && now.getTime() - new Date(a.last_sent_at).getTime() < a.min_interval_seconds * 1000 * jitter) continue;
    const used = await run((q) => sentToday(q, a.id));
    if (used >= accountCap(a)) continue;
    const next = await run((q) => q.maybe<{ id: string; send_window: Record<string, unknown> | null }>(sql`
      select m.id, c.send_window from outreach_messages m
      left join campaigns c on c.id = m.campaign_id
      where m.status = 'queued' and m.channel = 'email' and m.queued_at <= now()
        and (m.sender_account_id = ${a.id} or (m.sender_account_id is null and (c.sender_account_id is null or c.sender_account_id = ${a.id})))
        and (c.id is null or c.status = 'active')
        and (c.daily_send_cap is null or (select count(*) from outreach_messages x where x.campaign_id = c.id and x.channel = 'email'
          and x.status = 'sent' and not x.is_test and x.sent_at >= date_trunc('day', now())) < c.daily_send_cap)
      order by m.kind = 'followup' desc, m.queued_at limit 1`));
    if (!next) continue;
    if (!opts.ignoreWindow && !withinWindow(now, next.send_window as never)) continue;
    const r = await sendEmailMessage(run, { workspaceId, actorType: "system" }, next.id, { fromQueue: true });
    if (r.ok) sent++;
  }
  return sent;
}

export async function dispatchAllWorkspaces(): Promise<number> {
  const ws = await withSystem((q) => q.many<{ id: string }>(sql`select id from workspaces`));
  let n = 0;
  for (const w of ws) n += await dispatchQueuedEmails(w.id);
  return n;
}

/** Automatic safety pause when deliverability deteriorates. */
export async function evaluateAccountSafety(q: Q, workspaceId: string, accountId: string): Promise<{ paused: boolean; bounceRate: number; complaintRate: number; sample: number }> {
  const s = await getEmailSettings(q, workspaceId);
  const r = await q.one<{ sample: number; bounced: number; complained: number }>(sql`
    with recent as (
      select id, delivery_status from outreach_messages where sender_account_id = ${accountId} and status = 'sent' and not is_test
      and sent_at > now() - interval '14 days' order by sent_at desc limit 200)
    select count(*)::int as sample, count(*) filter (where delivery_status = 'bounced')::int as bounced,
           count(*) filter (where delivery_status = 'complained')::int as complained from recent`);
  const bounceRate = r.sample ? r.bounced / r.sample : 0;
  const complaintRate = r.sample ? r.complained / r.sample : 0;
  let paused = false;
  if (r.sample >= s.safety.minSample && (bounceRate > s.safety.maxBounceRate || complaintRate > s.safety.maxComplaintRate)) {
    const reason = bounceRate > s.safety.maxBounceRate
      ? `Safety pause: bounce rate ${(bounceRate * 100).toFixed(1)}% over the last ${r.sample} emails (limit ${(s.safety.maxBounceRate * 100).toFixed(0)}%)`
      : `Safety pause: complaint rate ${(complaintRate * 100).toFixed(2)}% (limit ${(s.safety.maxComplaintRate * 100).toFixed(1)}%)`;
    const row = await q.maybe(sql`update sender_accounts set status = 'paused', paused_reason = ${reason}, paused_at = now() where id = ${accountId} and status = 'active' returning id`);
    if (row) {
      paused = true;
      await notify(q, workspaceId, { type: "safety_pause", title: "Email sending paused for safety", body: reason, link: "/integrations#sending" });
      await audit(q, { workspaceId, actorType: "system" }, "email.safety_pause", "sender_account", accountId, { bounceRate, complaintRate, sample: r.sample });
    }
  }
  return { paused, bounceRate, complaintRate, sample: r.sample };
}

export { json };
