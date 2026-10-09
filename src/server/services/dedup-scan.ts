import { sql, json } from "../db";
import type { JobContext } from "../jobs/worker";
import { compareProspects, type DedupRecord } from "../domain/dedup";

/**
 * Workspace-wide duplicate scan (for records that entered before a match
 * existed, or after merges). Uses trigram similarity for candidate pairs,
 * then the same scorer as ingestion. Only flags — never merges.
 */
export async function scanDuplicates(ctx: JobContext) {
  const ids = await ctx.ws((q) => q.many<{ id: string }>(sql`select id from prospects where merged_into is null and archived_at is null order by created_at`));
  let flagged = 0;
  for (let i = 0; i < ids.length; i += 200) {
    await ctx.progress(i, ids.length, "Scanning for duplicates");
    const chunk = ids.slice(i, i + 200).map((r) => r.id);
    flagged += await ctx.ws(async (q) => {
      let n = 0;
      const pairs = await q.many<{ a: DedupRecord & { id: string }; b: DedupRecord & { id: string } }>(sql`
        select to_jsonb(x) as a, to_jsonb(y) as b from (
          select p1.id, p1.business_name, p1.city, p1.instagram_handle, p1.tiktok_handle, p1.phone, p1.whatsapp, p1.email, p1.website_domain, p1.owner_name, p1.source_url, p1.normalized_name
          from prospects p1 where p1.id = any(${`{${chunk.join(",")}}`}::uuid[])) x
        join lateral (
          select p2.id, p2.business_name, p2.city, p2.instagram_handle, p2.tiktok_handle, p2.phone, p2.whatsapp, p2.email, p2.website_domain, p2.owner_name, p2.source_url
          from prospects p2
          where p2.id > x.id and p2.merged_into is null and (
            p2.normalized_name % x.normalized_name
            or (x.phone is not null and (p2.phone = x.phone or p2.whatsapp = x.phone))
            or (x.email is not null and lower(p2.email) = lower(x.email)))
          limit 10) y on true`);
      for (const { a, b } of pairs) {
        const m = compareProspects(a, b);
        if (m.decision === "distinct") continue;
        const r = await q.many(sql`insert into possible_duplicates (workspace_id, prospect_a, prospect_b, confidence, reasons)
          values (${ctx.workspaceId}, ${a.id}, ${b.id}, ${m.confidence}, ${json({ reasons: m.reasons, conflicts: m.conflicts })})
          on conflict (prospect_a, prospect_b) do nothing returning id`);
        n += r.length;
      }
      return n;
    });
  }
  return { scanned: ids.length, flagged };
}
