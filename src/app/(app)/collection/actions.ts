"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { audit } from "@/server/services/audit";
import { planCollection, saveCollectionSettings, getCollectionSettings } from "@/server/collection/engine";
import { COUNTRY_BY_CC } from "@/server/collection/countries";
import { COLLECTION_SOURCES } from "@/server/collection/sources";
import type { ActionResult } from "@/components/ui/dialog";

const startSchema = z.object({
  countries: z.array(z.string().length(2)).min(1, "Pick at least one country"),
  sources: z.array(z.string()).min(1, "Pick at least one source"),
  target: z.number().int().min(100).max(10_000_000),
  autoExpand: z.boolean(),
  crawl: z.boolean(),
});

export async function startCollectionAction(input: z.input<typeof startSchema>): Promise<ActionResult> {
  const user = await requireUser("admin");
  const v = startSchema.safeParse(input);
  if (!v.success) return { ok: false, error: v.error.issues[0].message };
  const countries = v.data.countries.map((c) => c.toUpperCase()).filter((c) => COUNTRY_BY_CC.has(c));
  const sources = v.data.sources.filter((s) => COLLECTION_SOURCES[s]);
  const added = await asUser(user, async (q) => {
    await saveCollectionSettings(q, user.workspaceId, { active: true, paused: false, countries, sources, target: v.data.target, autoExpand: v.data.autoExpand, crawl: v.data.crawl });
    const n = await planCollection(q, user.workspaceId, countries, sources);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "collection.started", "workspace", user.workspaceId, { countries, sources, units: n });
    return n;
  });
  revalidatePath("/collection");
  return { ok: true, message: `Collection running · ${added} new work units queued. It continues in the background and resumes after restarts.` };
}

export async function setCollectionPausedAction(paused: boolean): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, async (q) => {
    await saveCollectionSettings(q, user.workspaceId, { paused });
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, paused ? "collection.paused" : "collection.resumed", "workspace", user.workspaceId);
  });
  revalidatePath("/collection");
  return { ok: true, message: paused ? "Collection paused. Progress is saved." : "Collection resumed" };
}

/** Put dead-lettered units back in the queue (e.g. after a source outage). */
export async function retryDeadUnitsAction(): Promise<ActionResult> {
  const user = await requireUser("member");
  const n = await asUser(user, async (q) => {
    const rows = await q.many(sql`update collection_units set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = null where status in ('dead','failed') returning id`);
    await q.exec(sql`update prospects set website_crawl_status = 'pending', website_crawl_attempts = 0, website_next_crawl_at = null where website_crawl_status = 'error'`);
    return rows.length;
  });
  revalidatePath("/collection");
  return { ok: true, message: `${n} units re-queued; failed website crawls re-queued` };
}

export async function stopCollectionAction(): Promise<ActionResult> {
  const user = await requireUser("admin");
  await asUser(user, async (q) => {
    const cur = await getCollectionSettings(q, user.workspaceId);
    await saveCollectionSettings(q, user.workspaceId, { ...cur, active: false });
  });
  revalidatePath("/collection");
  return { ok: true, message: "Collection stopped. Queued work is kept; start again to continue." };
}
