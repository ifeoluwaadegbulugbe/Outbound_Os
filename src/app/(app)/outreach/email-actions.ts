"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, textArray } from "@/server/db";
import { sendEmailMessage, sendTestEmail, queueEmails } from "@/server/email/send";
import { normalizeAddress } from "@/server/email/address";
import { audit } from "@/server/services/audit";
import type { Run } from "@/server/email/providers";
import type { ActionResult } from "@/components/ui/dialog";

const ids = z.array(z.string().uuid()).min(1).max(2000);

async function ctx(role: "member" | "admin" = "member") {
  const user = await requireUser(role);
  const run: Run = (fn) => asUser(user, fn);
  return { user, run, actor: { workspaceId: user.workspaceId, actorType: "user" as const, actorId: user.userId } };
}

function refresh() {
  revalidatePath("/outreach");
  revalidatePath("/");
}

/**
 * Send one email now through the connected mailbox. The message is only
 * marked sent after the provider confirms; on failure the draft stays and the
 * provider's error is shown.
 */
export async function sendEmailNowAction(id: string): Promise<ActionResult> {
  const { run, actor } = await ctx();
  const r = await sendEmailMessage(run, actor, z.string().uuid().parse(id));
  refresh();
  revalidatePath(`/outreach/compose/${id}`);
  return r.ok ? { ok: true, message: "Sent. Provider confirmed delivery to the mail server." } : { ok: false, error: r.error };
}

export async function sendTestEmailAction(id: string, to: string): Promise<ActionResult> {
  const { run, actor } = await ctx();
  const addr = normalizeAddress(to);
  if (!addr) return { ok: false, error: "Enter a valid address for the test" };
  const r = await sendTestEmail(run, actor, z.string().uuid().parse(id), addr);
  return r.ok ? { ok: true, message: `Test sent to ${addr} (subject starts with [Test])` } : { ok: false, error: r.error };
}

/** Queue approved emails for the paced sender (caps, intervals and send window apply). */
export async function queueEmailsAction(input: string[] | "all_approved"): Promise<ActionResult> {
  const { user, actor } = await ctx();
  const r = await asUser(user, async (q) => {
    const list = input === "all_approved"
      ? (await q.many<{ id: string }>(sql`select id from outreach_messages where channel = 'email' and status = 'approved' and not is_test order by kind = 'followup' desc, approved_at limit 2000`)).map((x) => x.id)
      : ids.parse(input);
    return queueEmails(q, actor, list);
  });
  refresh();
  if (!r.queued) return { ok: false, error: r.blocked[0]?.reason ?? "Nothing to queue" };
  return { ok: true, message: `${r.queued} queued${r.blocked.length ? ` · ${r.blocked.length} held back (${r.blocked[0].reason})` : ""}. They go out one at a time within each account's limits.` };
}

export async function unqueueEmailsAction(input: string[] | "all"): Promise<ActionResult> {
  const { user, actor } = await ctx();
  const n = await asUser(user, async (q) => {
    const where = input === "all" ? sql`true` : sql`id = any(${textArray(ids.parse(input))}::uuid[])`;
    const rows = await q.many(sql`update outreach_messages set status = 'approved', queued_at = null where status = 'queued' and channel = 'email' and ${where} returning id`);
    if (rows.length) await audit(q, actor, "email.unqueued", null, null, { count: rows.length });
    return rows.length;
  });
  refresh();
  return { ok: true, message: `${n} email${n === 1 ? "" : "s"} moved back to Ready` };
}

/** Choose which discovered address a draft goes to (makes it the prospect's primary email). */
export async function setPrimaryEmailAction(prospectId: string, email: string): Promise<ActionResult> {
  const { user, actor } = await ctx();
  const r = await asUser(user, async (q) => {
    const c = await q.maybe<{ value: string; source: string | null; source_url: string | null; discovered_at: Date | null; verification_status: string | null; verified_at: Date | null }>(sql`
      select value, source, source_url, discovered_at, verification_status, verified_at from prospect_contacts
      where prospect_id = ${z.string().uuid().parse(prospectId)} and kind = 'email' and value = ${email.toLowerCase()}`);
    if (!c) return { ok: false as const, error: "That address isn't one of this prospect's discovered emails" };
    await q.exec(sql`update prospect_contacts set is_primary = (value = ${c.value}) where prospect_id = ${prospectId} and kind = 'email'`);
    await q.exec(sql`update prospects set email = ${c.value}, email_source = ${c.source}, email_source_url = ${c.source_url}, email_discovered_at = ${c.discovered_at},
      email_status = ${c.verification_status ?? "unverified"}, email_verified_at = ${c.verified_at} where id = ${prospectId}`);
    await audit(q, actor, "prospect.primary_email", "prospect", prospectId, { email: c.value });
    return { ok: true as const, message: `Will send to ${c.value}` };
  });
  revalidatePath("/outreach");
  return r;
}

export async function setMessageSenderAction(id: string, senderAccountId: string | null): Promise<ActionResult> {
  const { user } = await ctx();
  await asUser(user, (q) => q.exec(sql`update outreach_messages set sender_account_id = ${senderAccountId} where id = ${z.string().uuid().parse(id)} and status not in ('sent','sending')`));
  return { ok: true, message: "Sending account updated" };
}
