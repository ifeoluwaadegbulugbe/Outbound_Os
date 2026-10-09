import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { DemoControls } from "../forms";

export const metadata = { title: "Demo data" };

export default async function DemoSettings() {
  const user = await requireUser("admin");
  const n = await asUser(user, (q) => q.value<number>(sql`select count(*)::int from prospects where is_demo`));
  return <DemoControls hasDemo={n > 0} />;
}
