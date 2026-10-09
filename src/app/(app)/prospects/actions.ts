"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, textArray, json } from "@/server/db";
import { addToCampaign } from "@/server/services/ingest";
import { parseNaturalLanguage, describeFilter, type FilterNode } from "@/server/domain/filters";
import { matchingIds, parseListParams } from "@/server/repos/prospects";
import { canTransition } from "@/server/domain/status";
import { PROSPECT_STATUSES, type ProspectStatus } from "@/server/domain/taxonomy";
import { rescoreProspect, getIcpConfig } from "@/server/services/scoring-service";
import { audit, logEvent } from "@/server/services/audit";
import { enqueue } from "@/server/jobs/queue";
import { suppressProspects } from "@/server/services/dnc";
import { parseFilterWithAi } from "@/server/ai/tasks/filters";
import type { ActionResult } from "@/components/ui/dialog";

/** Selection: explicit ids, or "all matching" the current list params. */
const selectionSchema = z.union([
  z.object({ ids: z.array(z.string().uuid()).min(1).max(5000) }),
  z.object({ allMatching: z.record(z.string(), z.string()) }),
]);
export type Selection = z.infer<typeof selectionSchema>;

async function resolveIds(q: Parameters<typeof matchingIds>[0], sel: Selection): Promise<string[]> {
  if ("ids" in sel) return sel.ids;
  return matchingIds(q, parseListParams(sel.allMatching));
}

export async function addToCampaignAction(sel: Selection, campaignId: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const s = selectionSchema.parse(sel);
  const n = await asUser(user, async (q) => {
    const ids = await resolveIds(q, s);
    const added = await addToCampaign(q, user.workspaceId, z.string().uuid().parse(campaignId), ids);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "prospects.added_to_campaign", "campaign", campaignId, { count: added });
    return added;
  });
  revalidatePath("/prospects");
  return { ok: true, message: `Added ${n} prospect${n === 1 ? "" : "s"} to campaign` };
}

export async function setStatusAction(sel: Selection, status: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const s = selectionSchema.parse(sel);
  if (!PROSPECT_STATUSES.includes(status as ProspectStatus)) return { ok: false, error: "Unknown status" };
  if (status === "DO_NOT_CONTACT") return { ok: false, error: "Use “Do not contact” so the suppression list is updated too." };
  const res = await asUser(user, async (q) => {
    const ids = await resolveIds(q, s);
    const rows = await q.many<{ id: string; status: ProspectStatus }>(sql`select id, status from prospects where id = any(${textArray(ids)}::uuid[])`);
    let changed = 0;
    const skipped: string[] = [];
    for (const r of rows) {
      const ok = canTransition(r.status, status as ProspectStatus);
      if (!ok.ok) {
        skipped.push(ok.reason ?? "invalid");
        continue;
      }
      await q.exec(sql`update prospects set status = ${status} where id = ${r.id}`);
      await logEvent(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, { type: "status.changed", prospectId: r.id, data: { from: r.status, to: status } });
      changed++;
    }
    return { changed, skipped };
  });
  revalidatePath("/prospects");
  if (res.changed === 0 && res.skipped.length) return { ok: false, error: `No changes: ${res.skipped[0]}` };
  return { ok: true, message: `Updated ${res.changed}${res.skipped.length ? ` · skipped ${res.skipped.length} (not allowed)` : ""}` };
}

export async function doNotContactAction(sel: Selection, reason: string, note?: string): Promise<ActionResult> {
  const user = await requireUser("member");
  const s = selectionSchema.parse(sel);
  const r = z.enum(["opt_out", "manual", "competitor", "customer", "invalid", "closed", "inappropriate"]).parse(reason);
  const n = await asUser(user, async (q) => suppressProspects(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, await resolveIds(q, s), r, note));
  revalidatePath("/prospects");
  return { ok: true, message: `${n} prospect${n === 1 ? "" : "s"} added to do-not-contact` };
}

export async function rescoreAction(sel: Selection): Promise<ActionResult> {
  const user = await requireUser("member");
  const s = selectionSchema.parse(sel);
  const n = await asUser(user, async (q) => {
    const ids = await resolveIds(q, s);
    const icp = await getIcpConfig(q);
    for (const id of ids) await rescoreProspect(q, id, icp);
    return ids.length;
  });
  revalidatePath("/prospects");
  return { ok: true, message: `Re-scored ${n}` };
}

export async function parseFilterAction(text: string): Promise<{ ok: true; filter: FilterNode; explanation: string[]; unparsed: string[]; description: string; source: string } | { ok: false; error: string }> {
  const user = await requireUser();
  const input = text.trim().slice(0, 300);
  if (!input) return { ok: false, error: "Describe who you're looking for." };
  const rules = parseNaturalLanguage(input);
  // Try AI only when the deterministic parser left words it didn't understand.
  if (rules.unparsed.length > 0) {
    const ai = await asUser(user, (q) => parseFilterWithAi(q, user.workspaceId, input)).catch(() => null);
    if (ai) return { ok: true, filter: ai.filter, explanation: ai.explanation, unparsed: [], description: describeFilter(ai.filter), source: ai.source };
  }
  return { ok: true, ...rules, description: describeFilter(rules.filter), source: "rules" };
}

export async function saveViewAction(name: string, params: Record<string, string>): Promise<ActionResult> {
  const user = await requireUser("member");
  const n = z.string().trim().min(1).max(60).parse(name);
  await asUser(user, (q) => q.exec(sql`insert into saved_views (workspace_id, user_id, page, name, params) values (${user.workspaceId}, null, 'prospects', ${n}, ${json(params)})`));
  revalidatePath("/prospects");
  return { ok: true, message: `Saved view “${n}”` };
}

export async function deleteViewAction(id: string): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, (q) => q.exec(sql`delete from saved_views where id = ${z.string().uuid().parse(id)}`));
  revalidatePath("/prospects");
  return { ok: true, message: "View deleted" };
}

/** Background job: look for public emails on each selected business's website. */
export async function findEmailsAction(sel: Selection): Promise<ActionResult> {
  const user = await requireUser("member");
  const s = selectionSchema.parse(sel);
  const n = await asUser(user, async (q) => {
    const all = await resolveIds(q, s);
    const ids = (await q.many<{ id: string }>(sql`select id from prospects where id = any(${textArray(all)}::uuid[]) and website is not null and email is null and not do_not_contact`)).map((r) => r.id);
    if (ids.length) await enqueue(q, { workspaceId: user.workspaceId, type: "enrich.emails", createdBy: user.userId, total: ids.length, payload: { prospectIds: ids } });
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "prospects.find_emails", "prospect", null, { selected: all.length, queued: ids.length });
    return { queued: ids.length, selected: all.length };
  });
  revalidatePath("/prospects");
  if (!n.queued) return { ok: false, error: "None of the selected prospects have a website without a known email." };
  return { ok: true, message: `Checking ${n.queued} website${n.queued === 1 ? "" : "s"} in the background${n.selected > n.queued ? ` (${n.selected - n.queued} skipped: no website or email already known)` : ""}` };
}

export async function verifyEmailsAction(sel: Selection): Promise<ActionResult> {
  const user = await requireUser("member");
  const s = selectionSchema.parse(sel);
  const n = await asUser(user, async (q) => {
    const all = await resolveIds(q, s);
    const ids = (await q.many<{ id: string }>(sql`select id from prospects where id = any(${textArray(all)}::uuid[]) and email is not null and email_status <> 'invalid'`)).map((r) => r.id);
    if (ids.length) await enqueue(q, { workspaceId: user.workspaceId, type: "enrich.verify", createdBy: user.userId, total: ids.length, payload: { prospectIds: ids } });
    return ids.length;
  });
  revalidatePath("/prospects");
  if (!n) return { ok: false, error: "None of the selected prospects have an email to verify." };
  return { ok: true, message: `Verifying ${n} email${n === 1 ? "" : "s"} in the background` };
}
