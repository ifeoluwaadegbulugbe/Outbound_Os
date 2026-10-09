import Papa from "papaparse";
import { getUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { parseListParams, prospectWhere } from "@/server/repos/prospects";
import { categoryLabel } from "@/server/domain/taxonomy";
import { audit } from "@/server/services/audit";

/** CSV export of the current (filtered) prospect list. Max 50k rows. */
export async function GET(req: Request) {
  const user = await getUser();
  if (!user) return new Response("Unauthorized", { status: 401 });
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const params = parseListParams(sp);
  const rows = await asUser(user, async (q) => {
    const r = await q.many<Record<string, unknown>>(sql`
      select p.business_name, p.owner_name, p.category, p.city, p.area, p.state, p.country, p.instagram_handle, p.tiktok_handle, p.facebook_url,
             p.phone, p.whatsapp, p.email, p.website, p.booking_url, p.follower_count, p.icp_score, p.priority_score, p.completeness_score, p.status,
             p.contact_count, p.last_contacted_at, p.signed_up, p.activated, p.paid, p.source,
             (select string_agg(c.name, '; ') from campaign_prospects cp join campaigns c on c.id = cp.campaign_id where cp.prospect_id = p.id) as campaigns
      from prospects p where ${prospectWhere(params)} order by p.priority_score desc nulls last limit 50000`);
    await audit(q, { workspaceId: user.workspaceId, actorType: "user", actorId: user.userId }, "prospects.exported", null, null, { count: r.length, params: sp });
    return r;
  });
  const csv = Papa.unparse(
    rows.map((r) => ({
      business: r.business_name, owner: r.owner_name, category: categoryLabel(r.category as string | null), city: r.city, area: r.area, state: r.state, country: r.country,
      instagram: r.instagram_handle ? `https://www.instagram.com/${r.instagram_handle}/` : "", tiktok: r.tiktok_handle ? `https://www.tiktok.com/@${r.tiktok_handle}` : "",
      facebook: r.facebook_url, phone: r.phone, whatsapp: r.whatsapp, email: r.email, website: r.website, booking_link: r.booking_url, followers: r.follower_count,
      icp_score: r.icp_score, priority: r.priority_score, data_completeness: r.completeness_score, status: r.status, times_contacted: r.contact_count,
      last_contacted: r.last_contacted_at ? new Date(r.last_contacted_at as string).toISOString() : "", signed_up: r.signed_up, activated: r.activated, paid: r.paid,
      campaigns: r.campaigns, source: r.source,
    })),
  );
  // Note: rows from OpenStreetMap remain © OpenStreetMap contributors (ODbL).
  return new Response("﻿" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="prospects-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
