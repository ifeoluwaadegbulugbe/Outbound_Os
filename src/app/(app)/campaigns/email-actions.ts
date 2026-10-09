"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json } from "@/server/db";
import { audit } from "@/server/services/audit";
import { COMPLIANCE_ITEMS } from "@/server/email/policy";
import type { ActionResult } from "@/components/ui/dialog";

const emailSchema = z.object({
  senderAccountId: z.string().uuid().nullable(),
  dailySendCap: z.number().int().min(1).max(5000).nullable(),
  followupDays: z.array(z.number().int().min(1).max(60)).max(4),
  window: z.object({
    days: z.array(z.number().int().min(0).max(6)).min(1, "Pick at least one sending day"),
    start: z.string().regex(/^\d\d:\d\d$/),
    end: z.string().regex(/^\d\d:\d\d$/),
    tz: z.string().min(3).max(60),
  }),
});

export async function updateCampaignEmailAction(id: string, input: z.input<typeof emailSchema>): Promise<ActionResult> {
  const user = await requireUser("member");
  const v = emailSchema.safeParse(input);
  if (!v.success) return { ok: false, error: v.error.issues[0].message };
  if (v.data.window.start >= v.data.window.end) return { ok: false, error: "The send window must end after it starts" };
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: v.data.window.tz });
  } catch {
    return { ok: false, error: "Unknown time zone" };
  }
  const days = [...new Set(v.data.followupDays)].sort((a, b) => a - b);
  await asUser(user, async (q) => {
    await q.exec(sql`update campaigns set sender_account_id = ${v.data.senderAccountId}, daily_send_cap = ${v.data.dailySendCap},
      followup_days = ${`{${days.join(",")}}`}::int[], send_window = ${json(v.data.window)} where id = ${z.string().uuid().parse(id)}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "campaign.email_settings", "campaign", id, { ...v.data, followupDays: days });
  });
  revalidatePath(`/campaigns/${id}`);
  return { ok: true, message: "Email settings saved" };
}

/** The compliance checklist must be complete (and is recorded with who/when) before any email in the campaign can send. */
export async function saveComplianceAction(id: string, checks: Record<string, boolean>): Promise<ActionResult> {
  const user = await requireUser("admin");
  const compliance: Record<string, unknown> = {};
  for (const item of COMPLIANCE_ITEMS) compliance[item.key] = Boolean(checks[item.key]);
  compliance.by = user.userId;
  compliance.byName = user.name;
  compliance.at = new Date().toISOString();
  await asUser(user, async (q) => {
    await q.exec(sql`update campaigns set compliance = ${json(compliance)} where id = ${z.string().uuid().parse(id)}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "campaign.compliance", "campaign", id, compliance);
  });
  revalidatePath(`/campaigns/${id}`);
  const done = COMPLIANCE_ITEMS.every((i) => compliance[i.key]);
  return { ok: true, message: done ? "Compliance checklist complete. Emails in this campaign can send." : "Saved. Emails stay blocked until every item is confirmed." };
}

const costSchema = z.object({ label: z.string().trim().min(2).max(120), amount: z.number().min(0).max(1e10), currency: z.string().trim().length(3).toUpperCase(), date: z.string().regex(/^\d{4}-\d\d-\d\d$/) });

/** Real spend (tools, data, ads, time) so analytics can show cost per activated/paid user. */
export async function addCostAction(campaignId: string, input: z.input<typeof costSchema>): Promise<ActionResult> {
  const user = await requireUser("member");
  const v = costSchema.safeParse(input);
  if (!v.success) return { ok: false, error: v.error.issues[0].message };
  await asUser(user, async (q) => {
    await q.exec(sql`insert into costs (workspace_id, campaign_id, label, amount, currency, incurred_on)
      values (${user.workspaceId}, ${z.string().uuid().parse(campaignId)}, ${v.data.label}, ${v.data.amount}, ${v.data.currency}, ${v.data.date})`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "campaign.cost_added", "campaign", campaignId, v.data);
  });
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true, message: "Cost recorded" };
}

export async function deleteCostAction(campaignId: string, costId: string): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, (q) => q.exec(sql`delete from costs where id = ${z.string().uuid().parse(costId)}`));
  revalidatePath(`/campaigns/${campaignId}`);
  return { ok: true, message: "Cost removed" };
}
