import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { WorkspaceForm, PasswordForm } from "./forms";

export const metadata = { title: "Settings" };

export default async function WorkspaceSettings() {
  const user = await requireUser();
  const ws = await asUser(user, (q) => q.one<{ name: string; product_name: string; product_signup_url: string | null; settings: { verifiedProof?: string[]; productFacts?: string[] } }>(
    sql`select name, product_name, product_signup_url, settings from workspaces where id = ${user.workspaceId}`));
  return (
    <>
      <WorkspaceForm ws={{ ...ws, verifiedProof: ws.settings.verifiedProof ?? [], productFacts: ws.settings.productFacts ?? [] }} canEdit={can(user, "admin")} />
      <PasswordForm />
    </>
  );
}
