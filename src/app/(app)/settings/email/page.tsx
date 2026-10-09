import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { getEmailSettings } from "@/server/email/policy";
import { EmailSettingsForm } from "../email-forms";

export const metadata = { title: "Email settings" };

export default async function EmailSettingsPage() {
  const user = await requireUser();
  const { s, countries } = await asUser(user, async (q) => ({
    s: await getEmailSettings(q, user.workspaceId),
    countries: await q.many<{ code: string; name: string }>(sql`select distinct country_code as code, country_name as name from locations order by name`),
  }));
  return (
    <EmailSettingsForm canEdit={can(user, "admin")} countries={countries}
      value={{
        senderName: s.sender.senderName || user.name, company: s.sender.company, address: s.sender.address ?? "", defaultCountry: s.defaultCountry,
        allowedStatuses: s.allowedStatuses, autoVerifyBeforeSend: s.autoVerifyBeforeSend, requireReviewForNew: s.requireReviewForNew,
        maxBounceRate: s.safety.maxBounceRate, maxComplaintRate: s.safety.maxComplaintRate, minSample: s.safety.minSample,
      }} />
  );
}
