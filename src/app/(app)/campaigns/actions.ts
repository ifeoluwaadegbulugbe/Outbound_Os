"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json, textArray } from "@/server/db";
import { parseNaturalLanguage, describeFilter, isGroup, type FilterNode } from "@/server/domain/filters";
import { parseFilterWithAi } from "@/server/ai/tasks/filters";
import { CATEGORY_KEYS, NIGERIAN_CITIES, CHANNELS } from "@/server/domain/taxonomy";
import { compileFilter } from "@/server/domain/filters-sql";
import { enqueue } from "@/server/jobs/queue";
import { audit } from "@/server/services/audit";
import type { ActionResult } from "@/components/ui/dialog";

const DEFAULT_VARIANTS = [
  { key: "A", name: "Problem-focused", angle: "problem_first" },
  { key: "B", name: "Curiosity", angle: "curiosity" },
  { key: "C", name: "Casual introduction", angle: "product_intro" },
  { key: "D", name: "Feedback request", angle: "feedback_request" },
];

/** Plain-English target → structured categories, cities and filter. */
export async function suggestTargetingAction(description: string): Promise<{ ok: true; categories: string[]; cities: string[]; filter: FilterNode; summary: string; source: string } | { ok: false; error: string }> {
  const user = await requireUser("member");
  const text = description.trim().slice(0, 500);
  if (!text) return { ok: false, error: "Describe who you're targeting first." };
  let parsed = parseNaturalLanguage(text);
  let source = "rules";
  if (parsed.unparsed.length) {
    const ai = await asUser(user, (q) => parseFilterWithAi(q, user.workspaceId, text)).catch(() => null);
    if (ai) {
      parsed = { filter: ai.filter, explanation: ai.explanation, unparsed: [] };
      source = ai.source;
    }
  }
  const conds = isGroup(parsed.filter) ? parsed.filter.children : [parsed.filter];
  const categories = new Set<string>();
  const cities = new Set<string>();
  for (const c of conds) {
    if (!("field" in c)) continue;
    const vals = Array.isArray(c.value) ? c.value : c.value != null ? [String(c.value)] : [];
    if (c.field === "category" && (c.cmp === "eq" || c.cmp === "in")) vals.forEach((v) => categories.add(v));
    if (c.field === "city" && (c.cmp === "eq" || c.cmp === "in")) vals.forEach((v) => cities.add(v));
  }
  return { ok: true, categories: [...categories], cities: [...cities], filter: parsed.filter, summary: describeFilter(parsed.filter), source };
}

const campaignSchema = z.object({
  name: z.string().trim().min(2, "Name the campaign").max(100),
  target_description: z.string().trim().max(1000).optional().default(""),
  categories: z.array(z.enum(CATEGORY_KEYS as [string, ...string[]])).max(20),
  cities: z.array(z.string().max(60)).max(20),
  country: z.string().length(2).default("NG"),
  channels: z.array(z.enum(CHANNELS)).min(1, "Pick at least one channel"),
  prospect_goal: z.number().int().positive().max(1_000_000).nullable(),
  objective: z.string().max(200).nullable(),
  offer: z.string().max(200).nullable(),
  tone: z.string().max(300).nullable(),
  instructions: z.string().max(2000).nullable(),
  constraints: z.object({
    maxChars: z.number().int().min(80).max(2000).optional(),
    noEmojis: z.boolean().optional(),
    mentionBookingLinkOnlyIfPresent: z.boolean().optional(),
    includeLinkInitial: z.boolean().optional(),
    requireName: z.boolean().optional(),
  }),
  start_date: z.string().nullable(),
  end_date: z.string().nullable(),
  targeting: z.any().nullable(),
  addMatching: z.boolean().default(true),
  minIcp: z.number().int().min(0).max(100).default(60),
  discovery: z.object({ adapter: z.string(), limit: z.number().int().min(1).max(5000) }).nullable(),
  createGoal: z.boolean().default(false),
  activate: z.boolean().default(true),
});

export type CampaignInput = z.input<typeof campaignSchema>;

export async function createCampaignAction(input: CampaignInput): Promise<ActionResult> {
  const user = await requireUser("member");
  const parsed = campaignSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Check the form" };
  const c = parsed.data;
  const result = await asUser(user, async (q) => {
    const base = c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "campaign";
    const exists = await q.value<number>(sql`select count(*)::int from campaigns where slug like ${base + "%"}`);
    const slug = exists ? `${base}-${exists + 1}` : base;
    const icpId = await q.value<string | null>(sql`select id from icp_profiles where is_default limit 1`);
    const seqId = await q.value<string | null>(sql`select id from followup_sequences where is_default limit 1`);
    const id = await q.value<string>(sql`
      insert into campaigns (workspace_id, name, slug, status, target_description, categories, country, cities, channels, prospect_goal, objective, offer, tone,
                             instructions, constraints, targeting, icp_profile_id, followup_sequence_id, start_date, end_date, created_by, code)
      values (${user.workspaceId}, ${c.name}, ${slug}, ${c.activate ? "active" : "draft"}, ${c.target_description || null}, ${textArray(c.categories)}, ${c.country},
              ${textArray(c.cities)}, ${textArray(c.channels)}, ${c.prospect_goal}, ${c.objective}, ${c.offer}, ${c.tone}, ${c.instructions}, ${json(c.constraints)},
              ${json(c.targeting ?? null)}, ${icpId}, ${seqId}, ${c.start_date || null}, ${c.end_date || null}, ${user.userId}, ${slug.replace(/-/g, "_").slice(0, 40)})
      returning id`);
    for (const v of DEFAULT_VARIANTS) {
      await q.exec(sql`insert into message_variants (workspace_id, campaign_id, key, name, angle) values (${user.workspaceId}, ${id}, ${v.key}, ${v.name}, ${v.angle})`);
    }
    let added = 0;
    if (c.addMatching) {
      const filter: FilterNode = { op: "and", children: [
        ...(c.categories.length ? [{ field: "category" as const, cmp: "in" as const, value: c.categories }] : []),
        ...(c.cities.length ? [{ field: "city" as const, cmp: "in" as const, value: c.cities }] : []),
        { field: "icp_score", cmp: "gte", value: c.minIcp },
        { field: "do_not_contact", cmp: "is_false" },
      ] };
      const rows = await q.many(sql`
        insert into campaign_prospects (workspace_id, campaign_id, prospect_id)
        select ${user.workspaceId}, ${id}, p.id from prospects p where p.merged_into is null and ${compileFilter(filter)}
        on conflict do nothing returning prospect_id`);
      added = rows.length;
    }
    let runId: string | null = null;
    if (c.discovery) {
      const cityKeys = NIGERIAN_CITIES.filter((x) => c.cities.includes(x.name)).map((x) => x.key);
      runId = await q.value<string>(sql`
        insert into discovery_runs (workspace_id, campaign_id, adapter, params, created_by)
        values (${user.workspaceId}, ${id}, ${c.discovery.adapter}, ${json({ categories: c.categories, cities: cityKeys, limit: c.discovery.limit })}, ${user.userId})
        returning id`);
      const jobId = await enqueue(q, { workspaceId: user.workspaceId, type: "discovery.run", createdBy: user.userId, total: c.discovery.limit,
        payload: { runId, adapter: c.discovery.adapter, categories: c.categories, cities: cityKeys, limit: c.discovery.limit, campaignId: id } });
      await q.exec(sql`update discovery_runs set job_id = ${jobId} where id = ${runId}`);
    }
    if (c.createGoal && c.prospect_goal && c.end_date) {
      await q.exec(sql`insert into goals (workspace_id, name, metric, target, start_date, end_date, campaign_id)
        values (${user.workspaceId}, ${`${c.prospect_goal.toLocaleString()} qualified prospects for ${c.name}`}, 'qualified', ${c.prospect_goal}, ${c.start_date || new Date()}, ${c.end_date}, ${id})`);
    }
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "campaign.created", "campaign", id, { name: c.name, added });
    return { id, added, runId };
  });
  revalidatePath("/campaigns");
  redirect(`/campaigns/${result.id}?created=1&added=${result.added}`);
}

export async function setCampaignStatusAction(id: string, status: "draft" | "active" | "paused" | "completed" | "archived"): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, async (q) => {
    await q.exec(sql`update campaigns set status = ${status} where id = ${z.string().uuid().parse(id)}`);
    if (status === "paused" || status === "archived") {
      // Pausing a campaign pulls its approved-but-unsent messages back to review.
      await q.exec(sql`update outreach_messages set status = 'needs_review' where campaign_id = ${id} and status in ('approved','scheduled')`);
    }
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, `campaign.${status}`, "campaign", id);
  });
  revalidatePath(`/campaigns/${id}`);
  revalidatePath("/campaigns");
  return { ok: true, message: `Campaign ${status}` };
}

export async function updateCampaignAction(id: string, patch: { instructions?: string | null; tone?: string | null; offer?: string | null; constraints?: Record<string, unknown>; prospect_goal?: number | null; channels?: string[] }): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, async (q) => {
    const cur = await q.one<{ constraints: Record<string, unknown> }>(sql`select constraints from campaigns where id = ${z.string().uuid().parse(id)}`);
    await q.exec(sql`update campaigns set
      instructions = coalesce(${patch.instructions ?? null}, instructions), tone = coalesce(${patch.tone ?? null}, tone), offer = coalesce(${patch.offer ?? null}, offer),
      prospect_goal = coalesce(${patch.prospect_goal ?? null}, prospect_goal), constraints = ${json({ ...cur.constraints, ...(patch.constraints ?? {}) })},
      channels = coalesce(${patch.channels ? textArray(patch.channels) : null}, channels)
      where id = ${id}`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "campaign.updated", "campaign", id, patch);
  });
  revalidatePath(`/campaigns/${id}`);
  return { ok: true, message: "Campaign updated" };
}

export async function addMatchingAction(id: string, minIcp: number): Promise<ActionResult> {
  const user = await requireUser("member");
  const n = await asUser(user, async (q) => {
    const c = await q.one<{ categories: string[]; cities: string[] }>(sql`select categories, cities from campaigns where id = ${z.string().uuid().parse(id)}`);
    const filter: FilterNode = { op: "and", children: [
      ...(c.categories.length ? [{ field: "category" as const, cmp: "in" as const, value: c.categories }] : []),
      ...(c.cities.length ? [{ field: "city" as const, cmp: "in" as const, value: c.cities }] : []),
      { field: "icp_score", cmp: "gte", value: minIcp },
      { field: "do_not_contact", cmp: "is_false" },
    ] };
    const rows = await q.many(sql`insert into campaign_prospects (workspace_id, campaign_id, prospect_id)
      select ${user.workspaceId}, ${id}, p.id from prospects p where p.merged_into is null and ${compileFilter(filter)} on conflict do nothing returning prospect_id`);
    return rows.length;
  });
  revalidatePath(`/campaigns/${id}`);
  return { ok: true, message: `Added ${n} matching prospects` };
}
