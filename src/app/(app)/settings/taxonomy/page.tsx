import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { CategoryManager, LocationManager } from "../email-forms";

export const metadata = { title: "Categories & locations" };

export default async function TaxonomyPage() {
  const user = await requireUser();
  const data = await asUser(user, async (q) => ({
    categories: await q.many<{ key: string; label: string; group_name: string; keywords: string[]; osm_tags: string[]; is_active: boolean; prospects: number }>(sql`
      select c.key, c.label, c.group_name, c.keywords, c.osm_tags, c.is_active,
        (select count(*) from prospects p where p.category = c.key and p.merged_into is null)::int as prospects
      from categories c order by c.created_at`),
    locations: await q.many<{ key: string; city: string; country_code: string; country_name: string; is_active: boolean; is_builtin: boolean; prospects: number }>(sql`
      select l.key, l.city, l.country_code, l.country_name, l.is_active, l.is_builtin,
        (select count(*) from prospects p where lower(p.city) = lower(l.city) and p.country = l.country_code and p.merged_into is null)::int as prospects
      from locations l order by l.country_name, l.is_builtin desc, l.city`),
  }));
  const admin = can(user, "admin");
  return (
    <>
      <CategoryManager rows={data.categories} canEdit={admin} />
      <LocationManager rows={data.locations} canEdit={admin} />
    </>
  );
}
