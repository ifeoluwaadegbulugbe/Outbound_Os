import { NextResponse } from "next/server";
import { getUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { categoryLabel } from "@/server/domain/taxonomy";

/** Global search for the command palette. Server-side, workspace-scoped (RLS). */
export async function GET(req: Request) {
  const user = await getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const term = new URL(req.url).searchParams.get("q")?.trim().slice(0, 100) ?? "";
  if (term.length < 2) return NextResponse.json({ results: [] });
  const like = `%${term.replace(/[%_\\]/g, "\\$&")}%`;
  const handle = term.replace(/^@/, "").toLowerCase();

  const results = await asUser(user, async (q) => {
    const prospects = await q.many<{ id: string; business_name: string; category: string | null; city: string | null; instagram_handle: string | null }>(sql`
      select id, business_name, category, city, instagram_handle from prospects
      where merged_into is null and (
        business_name ilike ${like} or lower(instagram_handle) like ${handle + "%"} or lower(tiktok_handle) like ${handle + "%"}
        or phone like ${"%" + term.replace(/\D/g, "") + "%"} and length(${term.replace(/\D/g, "")}) >= 6
        or lower(city) = ${term.toLowerCase()} or email ilike ${like})
      order by similarity(business_name, ${term}) desc, priority_score desc nulls last
      limit 8`);
    const campaigns = await q.many<{ id: string; name: string; status: string }>(sql`
      select id, name, status from campaigns where name ilike ${like} order by created_at desc limit 4`);
    const convos = await q.many<{ id: string; prospect_id: string; business_name: string; body: string }>(sql`
      select distinct on (c.id) c.id, c.prospect_id, p.business_name, m.body
      from conversation_messages m join conversations c on c.id = m.conversation_id join prospects p on p.id = c.prospect_id
      where m.body ilike ${like} order by c.id, m.occurred_at desc limit 4`);
    return [
      ...prospects.map((p) => ({
        type: "prospect", id: p.id, label: p.business_name, href: `/prospects/${p.id}`,
        sub: [p.instagram_handle && `@${p.instagram_handle}`, categoryLabel(p.category), p.city].filter(Boolean).join(" · "),
      })),
      ...campaigns.map((c) => ({ type: "campaign", id: c.id, label: c.name, sub: c.status, href: `/campaigns/${c.id}` })),
      ...convos.map((c) => ({ type: "conversation", id: c.id, label: c.business_name, sub: c.body.slice(0, 60), href: `/inbox?c=${c.id}` })),
    ];
  });
  return NextResponse.json({ results });
}
