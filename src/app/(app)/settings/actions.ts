"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, raw, json } from "@/server/db";
import { addMember, type Role } from "@/server/auth/service";
import { validatePasswordStrength, newToken } from "@/server/auth/password";
import { enqueue } from "@/server/jobs/queue";
import { loadDemoData, clearDemoData } from "@/server/seed/demo";
import { normalizeEmail, normalizeHandle, normalizePhone, domainOf } from "@/server/domain/normalize";
import { CATEGORY_KEYS, CHANNELS } from "@/server/domain/taxonomy";
import { audit } from "@/server/services/audit";
import type { ActionResult } from "@/components/ui/dialog";

const actor = (u: { workspaceId: string; userId: string }) => ({ workspaceId: u.workspaceId, actorType: "user" as const, actorId: u.userId });

export async function updateWorkspaceAction(input: { name: string; productName: string; signupUrl: string; verifiedProof: string; productFacts: string }): Promise<ActionResult> {
  const user = await requireUser("admin");
  const url = input.signupUrl.trim();
  if (url && !/^https:\/\//.test(url)) return { ok: false, error: "Signup URL must start with https://" };
  const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean).slice(0, 30);
  await asUser(user, async (q) => {
    const cur = await q.one<{ settings: Record<string, unknown> }>(sql`select settings from workspaces where id = ${user.workspaceId}`);
    await q.exec(sql`update workspaces set name = ${z.string().trim().min(1).max(80).parse(input.name)}, product_name = ${z.string().trim().min(1).max(60).parse(input.productName)},
      product_signup_url = ${url || null}, settings = ${json({ ...cur.settings, verifiedProof: lines(input.verifiedProof), productFacts: lines(input.productFacts) })} where id = ${user.workspaceId}`);
    await audit(q, actor(user), "workspace.updated", "workspace", user.workspaceId);
  });
  revalidatePath("/settings");
  return { ok: true, message: "Saved" };
}

export async function addMemberAction(input: { email: string; name: string; role: Role }): Promise<{ ok: true; password: string } | { ok: false; error: string }> {
  const user = await requireUser("admin");
  const email = normalizeEmail(input.email);
  if (!email) return { ok: false, error: "Enter a valid email" };
  if (input.role === "owner" && user.role !== "owner") return { ok: false, error: "Only an owner can add owners" };
  const password = `${newToken(9)}9a`;
  await addMember({ workspaceId: user.workspaceId, actorId: user.userId }, { email, name: input.name.trim() || email, role: input.role, password });
  revalidatePath("/settings/team");
  return { ok: true, password };
}

export async function setMemberRoleAction(userId: string, role: Role | "remove"): Promise<ActionResult> {
  const user = await requireUser("admin");
  if (userId === user.userId) return { ok: false, error: "You can't change your own role." };
  await asUser(user, async (q) => {
    const target = await q.one<{ role: Role }>(sql`select role from workspace_members where user_id = ${z.string().uuid().parse(userId)} and workspace_id = ${user.workspaceId}`);
    if (target.role === "owner" && user.role !== "owner") throw new Error("Only owners can change owners");
    if (role === "remove") await q.exec(sql`delete from workspace_members where user_id = ${userId} and workspace_id = ${user.workspaceId}`);
    else await q.exec(sql`update workspace_members set role = ${role} where user_id = ${userId} and workspace_id = ${user.workspaceId}`);
    await audit(q, actor(user), role === "remove" ? "team.member_removed" : "team.role_changed", "user", userId, { role });
  });
  revalidatePath("/settings/team");
  return { ok: true, message: role === "remove" ? "Removed" : "Role updated" };
}

export async function changePasswordAction(current: string, next: string): Promise<ActionResult> {
  const user = await requireUser();
  const weak = validatePasswordStrength(next);
  if (weak) return { ok: false, error: weak };
  const { verifyPassword, hashPassword } = await import("@/server/auth/password");
  const { withSystem } = await import("@/server/db");
  const row = await withSystem((q) => q.one<{ password_hash: string }>(sql`select password_hash from users where id = ${user.userId}`));
  if (!(await verifyPassword(current, row.password_hash))) return { ok: false, error: "Current password is incorrect" };
  const hash = await hashPassword(next);
  await withSystem(async (q) => {
    await q.exec(sql`update users set password_hash = ${hash} where id = ${user.userId}`);
    await q.exec(sql`delete from sessions where user_id = ${user.userId} and id <> ${user.sessionId}`);
  });
  return { ok: true, message: "Password changed · other sessions signed out" };
}

const senderSchema = z.object({
  id: z.string().uuid().nullable(),
  channel: z.enum(CHANNELS),
  label: z.string().trim().min(1).max(80),
  dailyCap: z.number().int().min(0).max(2000),
  warmupEnabled: z.boolean(),
  warmupStartCap: z.number().int().min(0).max(500),
  warmupStep: z.number().int().min(0).max(200),
  isActive: z.boolean(),
});

export async function saveSenderAction(input: z.input<typeof senderSchema>): Promise<ActionResult> {
  const user = await requireUser("member");
  const s = senderSchema.safeParse(input);
  if (!s.success) return { ok: false, error: s.error.issues[0].message };
  const v = s.data;
  await asUser(user, async (q) => {
    if (v.id) {
      await q.exec(sql`update sender_accounts set channel = ${v.channel}, label = ${v.label}, daily_cap = ${v.dailyCap}, warmup_enabled = ${v.warmupEnabled},
        warmup_start_cap = ${v.warmupStartCap}, warmup_step = ${v.warmupStep}, is_active = ${v.isActive} where id = ${v.id}`);
    } else {
      await q.exec(sql`insert into sender_accounts (workspace_id, user_id, channel, label, daily_cap, warmup_enabled, warmup_start_cap, warmup_step)
        values (${user.workspaceId}, ${user.userId}, ${v.channel}, ${v.label}, ${v.dailyCap}, ${v.warmupEnabled}, ${v.warmupStartCap}, ${v.warmupStep})`);
    }
    await audit(q, actor(user), "sender.saved", "sender_account", v.id, { channel: v.channel, cap: v.dailyCap });
  });
  revalidatePath("/settings/senders");
  return { ok: true, message: "Sender account saved" };
}

export async function saveIcpAction(input: { targetCategories: string[]; targetCities: string[]; minFollowers: number; qualifyThreshold: number }): Promise<ActionResult> {
  const user = await requireUser("admin");
  const cfg = z.object({
    targetCategories: z.array(z.enum(CATEGORY_KEYS as [string, ...string[]])).min(1, "Pick at least one category"),
    targetCities: z.array(z.string().max(60)).min(1, "Pick at least one city"),
    minFollowers: z.number().int().min(0).max(1_000_000),
    qualifyThreshold: z.number().int().min(1).max(100),
  }).safeParse(input);
  if (!cfg.success) return { ok: false, error: cfg.error.issues[0].message };
  await asUser(user, async (q) => {
    await q.exec(sql`update icp_profiles set config = config || ${json({ ...cfg.data, targetCountry: "NG" })} where is_default`);
    await enqueue(q, { workspaceId: user.workspaceId, type: "prospects.rescore", createdBy: user.userId, dedupeKey: "prospects.rescore" });
    await audit(q, actor(user), "icp.updated", "icp_profile", null, cfg.data);
  });
  revalidatePath("/settings/icp");
  return { ok: true, message: "Saved — re-scoring every prospect in the background" };
}

export async function saveGoalAction(input: { name: string; metric: string; target: number; startDate: string; endDate: string; campaignId: string | null; geography: string | null }): Promise<ActionResult> {
  const user = await requireUser("member");
  const g = z.object({
    name: z.string().trim().min(2).max(120),
    metric: z.enum(["discovered", "qualified", "contacted", "replied", "interested", "signed_up", "activated", "paid"]),
    target: z.number().int().positive(),
    startDate: z.string().min(8),
    endDate: z.string().min(8),
    campaignId: z.string().uuid().nullable(),
    geography: z.string().max(60).nullable(),
  }).safeParse(input);
  if (!g.success) return { ok: false, error: g.error.issues[0].message };
  if (g.data.endDate < g.data.startDate) return { ok: false, error: "End date must be after start date" };
  await asUser(user, (q) => q.exec(sql`insert into goals (workspace_id, name, metric, target, start_date, end_date, campaign_id, geography)
    values (${user.workspaceId}, ${g.data.name}, ${g.data.metric}, ${g.data.target}, ${g.data.startDate}, ${g.data.endDate}, ${g.data.campaignId}, ${g.data.geography || null})`));
  revalidatePath("/settings/goals");
  revalidatePath("/");
  return { ok: true, message: "Goal created" };
}

export async function deleteGoalAction(id: string): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, (q) => q.exec(sql`delete from goals where id = ${z.string().uuid().parse(id)}`));
  revalidatePath("/settings/goals");
  return { ok: true, message: "Goal deleted" };
}

export async function saveSequenceAction(steps: { day: number; angle: string; instructions: string }[]): Promise<ActionResult> {
  const user = await requireUser("admin");
  const s = z.array(z.object({ day: z.number().int().min(1).max(90), angle: z.string().max(40), instructions: z.string().max(400) })).min(0).max(6).parse(steps)
    .sort((a, b) => a.day - b.day);
  await asUser(user, async (q) => {
    await q.exec(sql`update followup_sequences set steps = ${json(s)} where is_default`);
    await audit(q, actor(user), "sequence.updated", "followup_sequence", null, { steps: s.length });
  });
  revalidatePath("/settings/sequences");
  return { ok: true, message: "Sequence saved (applies to follow-ups scheduled from now on)" };
}

export async function addDncAction(kind: string, value: string, reason: string, note: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const k = z.enum(["email", "phone", "instagram", "tiktok", "domain"]).parse(kind);
  const v = k === "email" ? normalizeEmail(value) : k === "phone" ? normalizePhone(value) : k === "domain" ? domainOf(value) : normalizeHandle(value);
  if (!v) return { ok: false, error: `That isn't a valid ${k}` };
  await asUser(user, async (q) => {
    await q.exec(sql`insert into dnc_entries (workspace_id, kind, value, reason, note, created_by) values (${user.workspaceId}, ${k}, ${v.toLowerCase()}, ${z.enum(["opt_out", "manual", "competitor", "customer", "invalid", "closed", "inappropriate"]).parse(reason)}, ${note || null}, ${user.userId})
      on conflict (workspace_id, kind, value) do nothing`);
    // Apply to existing prospects with that identifier.
    const col = { email: "lower(email)", phone: "phone", instagram: "lower(instagram_handle)", tiktok: "lower(tiktok_handle)", domain: "website_domain" }[k];
    const ids = await q.many<{ id: string }>(sql`select id from prospects where ${raw(col)} = ${v.toLowerCase()} and merged_into is null`);
    if (ids.length) {
      const { suppressProspects } = await import("@/server/services/dnc");
      await suppressProspects(q, actor(user), ids.map((r) => r.id), reason as never, note || null);
    }
    await audit(q, actor(user), "dnc.manual_entry", "dnc_entry", null, { kind: k });
  });
  revalidatePath("/settings/dnc");
  return { ok: true, message: "Added to the suppression list" };
}

export async function loadDemoAction(): Promise<ActionResult> {
  const user = await requireUser("admin");
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_MOCK_SOURCES !== "true") return { ok: false, error: "Demo data is disabled in production." };
  const s = await asUser(user, async (q) => {
    const existing = await q.value<number>(sql`select count(*)::int from prospects where is_demo`);
    if (existing) return null;
    return loadDemoData(q, { workspaceId: user.workspaceId, userId: user.userId, productName: user.productName });
  });
  revalidatePath("/", "layout");
  return s ? { ok: true, message: `Loaded ${s.prospects} fictional prospects` } : { ok: false, error: "Demo data is already loaded." };
}

export async function clearDemoAction(): Promise<ActionResult> {
  const user = await requireUser("admin");
  const n = await asUser(user, async (q) => {
    const c = await clearDemoData(q);
    await audit(q, actor(user), "demo.cleared", null, null, { prospects: c });
    return c;
  });
  revalidatePath("/", "layout");
  return { ok: true, message: `Removed ${n} demo prospects and their history` };
}

export async function retryJobAction(id: string): Promise<ActionResult> {
  const user = await requireUser("admin");
  await asUser(user, (q) => q.exec(sql`update jobs set status = 'queued', attempts = 0, run_at = now(), last_error = null, finished_at = null where id = ${z.string().uuid().parse(id)} and status = 'failed'`));
  revalidatePath("/settings/system");
  return { ok: true, message: "Job re-queued" };
}

export async function cancelJobAction(id: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const { cancelJob } = await import("@/server/jobs/queue");
  await asUser(user, (q) => cancelJob(q, z.string().uuid().parse(id)));
  revalidatePath("/settings/system");
  return { ok: true, message: "Cancellation requested" };
}
