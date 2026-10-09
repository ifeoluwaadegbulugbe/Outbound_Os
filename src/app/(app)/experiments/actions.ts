"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json } from "@/server/db";
import { audit } from "@/server/services/audit";
import type { ActionResult } from "@/components/ui/dialog";

const schema = z.object({
  name: z.string().trim().min(2).max(120),
  hypothesis: z.string().max(500).nullable(),
  kind: z.enum(["icp", "message", "channel", "offer"]),
  primaryMetric: z.enum(["reply_rate", "interest_rate", "signup_rate", "activation_rate", "paid_rate"]),
  campaignId: z.string().uuid().nullable(),
  variants: z.array(z.object({ name: z.string().trim().min(1).max(80), value: z.string().trim().min(1).max(80) })).min(2).max(4),
});

export async function createExperimentAction(input: z.input<typeof schema>): Promise<ActionResult> {
  const user = await requireUser("member");
  const e = schema.safeParse(input);
  if (!e.success) return { ok: false, error: e.error.issues[0].message };
  const key = { icp: "category", message: "angle", channel: "channel", offer: "offer" }[e.data.kind];
  await asUser(user, async (q) => {
    const id = await q.value<string>(sql`
      insert into experiments (workspace_id, campaign_id, name, hypothesis, kind, primary_metric, status, started_at)
      values (${user.workspaceId}, ${e.data.campaignId}, ${e.data.name}, ${e.data.hypothesis}, ${e.data.kind}, ${e.data.primaryMetric}, 'running', now()) returning id`);
    for (const [i, v] of e.data.variants.entries()) {
      await q.exec(sql`insert into experiment_variants (workspace_id, experiment_id, key, name, config) values (${user.workspaceId}, ${id}, ${String.fromCharCode(65 + i)}, ${v.name}, ${json({ [key]: v.value })})`);
    }
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "experiment.created", "experiment", id, { name: e.data.name });
  });
  revalidatePath("/experiments");
  return { ok: true, message: "Experiment started — results count prospects contacted from now on" };
}

export async function setExperimentStatusAction(id: string, status: "running" | "stopped" | "completed"): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, (q) => q.exec(sql`update experiments set status = ${status}, ended_at = ${status === "running" ? null : new Date()} where id = ${z.string().uuid().parse(id)}`));
  revalidatePath("/experiments");
  return { ok: true, message: `Experiment ${status}` };
}
