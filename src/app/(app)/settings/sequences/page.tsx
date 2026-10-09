import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { SequenceForm } from "../forms";
import { DEFAULT_FOLLOWUP_STEPS } from "@/server/services/workspace-defaults";

export const metadata = { title: "Follow-up sequence" };

export default async function SequenceSettings() {
  const user = await requireUser();
  const seq = await asUser(user, (q) => q.maybe<{ steps: { day: number; angle: string; instructions?: string }[] }>(sql`select steps from followup_sequences where is_default limit 1`));
  return <SequenceForm steps={seq?.steps ?? DEFAULT_FOLLOWUP_STEPS} canEdit={can(user, "admin")} />;
}
