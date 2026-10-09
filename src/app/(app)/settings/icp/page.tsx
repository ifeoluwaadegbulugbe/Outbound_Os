import { requireUser, asUser, can } from "@/server/auth/session";
import { getIcpConfig } from "@/server/services/scoring-service";
import { IcpForm } from "../forms";

export const metadata = { title: "ICP & scoring" };

export default async function IcpSettings() {
  const user = await requireUser();
  const { config } = await asUser(user, (q) => getIcpConfig(q));
  return <IcpForm config={config} canEdit={can(user, "admin")} />;
}
