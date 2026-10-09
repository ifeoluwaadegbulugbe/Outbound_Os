"use server";

import { revalidatePath } from "next/cache";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { audit } from "@/server/services/audit";
import type { ActionResult } from "@/components/ui/dialog";

export async function setOutreachPausedAction(paused: boolean): Promise<ActionResult> {
  const user = await requireUser("member");
  await asUser(user, async (q) => {
    await q.exec(sql`update workspaces set outreach_paused = ${paused}, outreach_paused_at = ${paused ? new Date() : null},
                     outreach_paused_by = ${paused ? user.userId : null} where id = ${user.workspaceId}`);
    // Approved-but-unsent messages go back to review when pausing, so nothing
    // slips out the moment outreach resumes.
    if (paused) await q.exec(sql`update outreach_messages set status = 'needs_review' where status = 'approved'`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, paused ? "outreach.paused" : "outreach.resumed", "workspace", user.workspaceId);
  });
  revalidatePath("/", "layout");
  return { ok: true, message: paused ? "All outreach paused" : "Outreach resumed" };
}

export async function markNotificationsReadAction(): Promise<ActionResult> {
  const user = await requireUser();
  await asUser(user, (q) => q.exec(sql`update notifications set read_at = now() where read_at is null and (user_id is null or user_id = ${user.userId})`));
  revalidatePath("/", "layout");
  return { ok: true, message: "All caught up" };
}
