"use server";

import { revalidatePath } from "next/cache";
import { requireUser, asUser } from "@/server/auth/session";
import { enqueue } from "@/server/jobs/queue";
import type { ActionResult } from "@/components/ui/dialog";

export async function draftDueFollowupsAction(): Promise<ActionResult> {
  const user = await requireUser("member");
  const id = await asUser(user, (q) => enqueue(q, { workspaceId: user.workspaceId, type: "followups.tick", createdBy: user.userId, dedupeKey: `followups.tick:manual:${Math.floor(Date.now() / 60_000)}` }));
  revalidatePath("/follow-ups");
  return id ? { ok: true, message: "Drafting due follow-ups — they'll appear in Outreach → Review" } : { ok: true, message: "Already running" };
}
