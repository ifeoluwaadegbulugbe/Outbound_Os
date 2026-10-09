"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json } from "@/server/db";
import { encryptSecret, decryptSecret } from "@/server/auth/crypto";
import { audit } from "@/server/services/audit";
import { checkSenderDomain } from "@/server/email/dns-check";
import { testSinkEnabled } from "@/server/email/providers";
import { zeroBounceCredits } from "@/server/email/verify";
import type { ActionResult } from "@/components/ui/dialog";

const id = z.string().uuid();

export async function setSenderPausedAction(accountId: string, paused: boolean, reason?: string): Promise<ActionResult> {
  const user = await requireUser("admin");
  await asUser(user, async (q) => {
    await q.exec(paused
      ? sql`update sender_accounts set status = 'paused', paused_reason = ${reason?.slice(0, 200) || "Paused manually"}, paused_at = now() where id = ${id.parse(accountId)}`
      : sql`update sender_accounts set status = 'active', paused_reason = null, paused_at = null, last_error = null where id = ${id.parse(accountId)} and status in ('paused', 'error')`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, paused ? "email.account_paused" : "email.account_resumed", "sender_account", accountId, { reason });
  });
  revalidatePath("/integrations");
  return { ok: true, message: paused ? "Sending paused for this account" : "Sending resumed" };
}

const limitsInput = z.object({
  dailyCap: z.number().int().min(1).max(2000),
  minIntervalSeconds: z.number().int().min(30).max(3600),
  warmupEnabled: z.boolean(),
  warmupStartCap: z.number().int().min(1).max(500),
  warmupStep: z.number().int().min(1).max(200),
});

export async function updateSenderLimitsAction(accountId: string, input: z.infer<typeof limitsInput>): Promise<ActionResult> {
  const user = await requireUser("admin");
  const v = limitsInput.safeParse(input);
  if (!v.success) return { ok: false, error: v.error.issues[0].message };
  const r = await asUser(user, async (q) => {
    const a = await q.maybe<{ provider_daily_limit: number | null }>(sql`select provider_daily_limit from sender_accounts where id = ${id.parse(accountId)}`);
    if (!a) return { ok: false as const, error: "Account not found" };
    // Caps can't exceed what the provider allows; the system never rotates accounts to get around limits.
    if (a.provider_daily_limit && v.data.dailyCap > a.provider_daily_limit) return { ok: false as const, error: `The provider allows at most ${a.provider_daily_limit}/day for this account.` };
    await q.exec(sql`update sender_accounts set daily_cap = ${v.data.dailyCap}, min_interval_seconds = ${v.data.minIntervalSeconds},
      warmup_enabled = ${v.data.warmupEnabled}, warmup_start_cap = ${v.data.warmupStartCap}, warmup_step = ${v.data.warmupStep} where id = ${accountId}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "email.account_limits", "sender_account", accountId, v.data);
    return { ok: true as const, message: "Limits saved" };
  });
  revalidatePath("/integrations");
  return r;
}

export async function checkSenderDnsAction(accountId: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const a = await asUser(user, (q) => q.maybe<{ email_address: string | null; provider: string }>(sql`select email_address, provider from sender_accounts where id = ${id.parse(accountId)}`));
  if (!a?.email_address) return { ok: false, error: "This account has no email address" };
  const check = await checkSenderDomain(a.email_address, a.provider);
  await asUser(user, (q) => q.exec(sql`update sender_accounts set dns_checks = ${json(check)}, dns_checked_at = now() where id = ${accountId}`));
  revalidatePath("/integrations");
  const ok = check.spf.ok && check.dmarc.ok && check.dkim.ok !== false;
  return { ok: true, message: check.managedByProvider ? "Authenticated by your mail provider" : ok ? "SPF, DKIM and DMARC look good" : "Some DNS records need attention. See details." };
}

export async function disconnectSenderAction(accountId: string): Promise<ActionResult> {
  const user = await requireUser("admin");
  await asUser(user, async (q) => {
    // Revokes our stored token; sent history stays for analytics. Queued messages go back to approved.
    await q.exec(sql`update outreach_messages set status = 'approved', queued_at = null where sender_account_id = ${id.parse(accountId)} and status = 'queued'`);
    await q.exec(sql`update sender_accounts set is_active = false, secret_ciphertext = null, status = 'paused', paused_reason = 'Disconnected' where id = ${accountId}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "email.account_disconnected", "sender_account", accountId);
  });
  revalidatePath("/integrations");
  return { ok: true, message: "Account disconnected. Also remove access in your Google/Microsoft account settings." };
}

/** Development only: a mailbox that captures messages locally and never delivers them. */
export async function createTestSinkAction(): Promise<ActionResult> {
  const user = await requireUser("admin");
  if (!testSinkEnabled()) return { ok: false, error: "The test mailbox is only available in development." };
  await asUser(user, async (q) => {
    await q.exec(sql`insert into sender_accounts (workspace_id, user_id, channel, label, provider, email_address, from_name, daily_cap, warmup_enabled, min_interval_seconds, provider_daily_limit)
      values (${user.workspaceId}, ${user.userId}, 'email', 'Test mailbox (never delivers)', 'test_sink', 'test-sender@outbound.test', ${user.name}, 200, false, 30, null)
      on conflict do nothing`);
    await q.exec(sql`update sender_accounts set is_active = true, status = 'active' where provider = 'test_sink'`);
  });
  revalidatePath("/integrations");
  return { ok: true, message: "Test mailbox added. Messages are stored locally, never sent." };
}

export async function saveZeroBounceKeyAction(key: string): Promise<ActionResult> {
  const user = await requireUser("admin");
  const k = key.trim();
  if (!k) {
    await asUser(user, (q) => q.exec(sql`update integrations set status = 'needs_setup', secret_ciphertext = null, config = '{}'::jsonb where key = 'zerobounce'`));
    revalidatePath("/integrations");
    return { ok: true, message: "ZeroBounce key removed. Using free DNS checks." };
  }
  const credits = await zeroBounceCredits(k);
  if (credits === null) return { ok: false, error: "ZeroBounce rejected that key (or couldn't be reached)." };
  await asUser(user, async (q) => {
    await q.exec(sql`update integrations set status = 'connected', secret_ciphertext = ${encryptSecret(k)}, config = ${json({ credits, checkedAt: new Date().toISOString() })}, last_error = null where key = 'zerobounce'`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "integration.connected", "integration", "zerobounce", { credits });
  });
  revalidatePath("/integrations");
  return { ok: true, message: `ZeroBounce connected · ${credits} credits left` };
}

export async function refreshZeroBounceCreditsAction(): Promise<ActionResult> {
  const user = await requireUser("member");
  const row = await asUser(user, (q) => q.maybe<{ secret_ciphertext: string | null }>(sql`select secret_ciphertext from integrations where key = 'zerobounce'`));
  const k = process.env.ZEROBOUNCE_API_KEY || (row?.secret_ciphertext ? decryptSecret(row.secret_ciphertext) : null);
  if (!k) return { ok: false, error: "No ZeroBounce key set" };
  const credits = await zeroBounceCredits(k);
  if (credits === null) return { ok: false, error: "Couldn't read credits from ZeroBounce" };
  await asUser(user, (q) => q.exec(sql`update integrations set config = config || ${json({ credits, checkedAt: new Date().toISOString() })} where key = 'zerobounce'`));
  revalidatePath("/integrations");
  return { ok: true, message: `${credits} credits left` };
}
