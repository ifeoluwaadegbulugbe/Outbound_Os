import { requireUser } from "@/server/auth/session";
import { PageHeader } from "@/components/ui/display";
import { SettingsNav } from "./nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  await requireUser();
  return (
    <>
      <PageHeader title="Settings" description="Workspace, sender identity, country rules, categories, scoring and system health." />
      <div className="grid gap-6 p-4 md:grid-cols-[190px_1fr] md:p-6">
        <SettingsNav />
        <div className="min-w-0 space-y-4">{children}</div>
      </div>
    </>
  );
}
