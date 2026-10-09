import { requireUser } from "@/server/auth/session";
import { PageHeader } from "@/components/ui/display";
import { ADAPTERS } from "@/server/adapters/registry";
import { CampaignForm } from "./campaign-form";

export const metadata = { title: "New campaign" };

export default async function NewCampaignPage() {
  await requireUser("member");
  const sources = Object.values(ADAPTERS).filter((a) => a.info.status !== "disabled").map((a) => ({ key: a.info.key, label: a.info.label, status: a.info.status }));
  return (
    <>
      <PageHeader title="New campaign" description="Describe who you're looking for. You can refine everything later." />
      <div className="p-4 md:p-6">
        <CampaignForm sources={sources} />
      </div>
    </>
  );
}
