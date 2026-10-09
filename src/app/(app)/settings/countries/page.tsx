import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { CountryPolicies, type PolicyRow } from "../email-forms";

export const metadata = { title: "Country rules" };

export default async function CountriesPage() {
  const user = await requireUser();
  const rows = await asUser(user, (q) => q.many<PolicyRow>(sql`
    select cp.country_code, coalesce((select max(country_name) from locations l where l.country_code = cp.country_code), cp.country_code) as country_name,
      cp.cold_email, cp.legal_basis, cp.notes, cp.acknowledged_at::text as acknowledged_at, u.name as acknowledged_by_name,
      (select count(*) from prospects p where p.country = cp.country_code and p.merged_into is null)::int as prospects
    from country_policies cp left join users u on u.id = cp.acknowledged_by
    order by (cp.cold_email = 'allowed') desc, country_name`));
  return <CountryPolicies rows={rows} canEdit={can(user, "admin")} />;
}
