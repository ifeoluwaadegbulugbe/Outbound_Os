"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser, asUser } from "@/server/auth/session";
import { sql, json } from "@/server/db";
import { parseNaturalLanguage, describeFilter, filterSchema, type FilterNode } from "@/server/domain/filters";
import { parseFilterWithAi } from "@/server/ai/tasks/filters";
import { compileFilter } from "@/server/domain/filters-sql";
import type { ActionResult } from "@/components/ui/dialog";

export async function previewSegmentAction(text: string): Promise<{ ok: true; filter: FilterNode; description: string; count: number; unparsed: string[] } | { ok: false; error: string }> {
  const user = await requireUser();
  const input = text.trim().slice(0, 300);
  if (!input) return { ok: false, error: "Describe the segment." };
  let r = parseNaturalLanguage(input);
  if (r.unparsed.length) {
    const ai = await asUser(user, (q) => parseFilterWithAi(q, user.workspaceId, input)).catch(() => null);
    if (ai) r = { filter: ai.filter, explanation: ai.explanation, unparsed: [] };
  }
  const count = await asUser(user, (q) => q.value<number>(sql`select count(*)::int from prospects p where p.merged_into is null and ${compileFilter(r.filter)}`));
  return { ok: true, filter: r.filter, description: describeFilter(r.filter), count, unparsed: r.unparsed };
}

export async function saveSegmentAction(name: string, text: string, filter: FilterNode): Promise<ActionResult> {
  const user = await requireUser("member");
  const f = filterSchema.parse(filter);
  await asUser(user, (q) => q.exec(sql`insert into segments (workspace_id, name, natural_language, rules, created_by)
    values (${user.workspaceId}, ${z.string().trim().min(1).max(80).parse(name)}, ${text.slice(0, 300)}, ${json(f)}, ${user.userId})`));
  revalidatePath("/segments");
  return { ok: true, message: "Segment saved" };
}

export async function deleteSegmentAction(id: string): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, (q) => q.exec(sql`delete from segments where id = ${z.string().uuid().parse(id)}`));
  revalidatePath("/segments");
  return { ok: true, message: "Segment deleted" };
}
