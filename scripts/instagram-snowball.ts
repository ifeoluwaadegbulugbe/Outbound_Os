import "./_env";
import { withSystem, withWorkspace, sql, type Q } from "@/server/db";
import { instagramAdapter } from "@/server/adapters/instagram";
import { ingestMany } from "@/server/services/ingest";
import { getIcpConfig } from "@/server/services/scoring-service";
import { judgeProfile } from "@/server/collection/instagram-snowball";
import { tiktokFromBio } from "@/server/collection/instagram-enrich";
import type { NormalizedProspect } from "@/server/adapters/types";

/**
 * Find new Instagram businesses by following the @mentions in the captions of
 * businesses we already have (vendors credit each other: "Makeup @x · Hair @y").
 * Official Business Discovery API only, at the account's hourly quota. New
 * accounts are kept only if they're small service businesses in a target
 * country (see collection/instagram-snowball.ts); known ones get refreshed.
 *
 *   npm run instagram:snowball -- [--seeds NG] [--limit 20] [--hours 24]
 */
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const seedCountries = (arg("--seeds") ?? "NG").split(",").map((c) => c.trim().toUpperCase());
const limit = Number(arg("--limit") ?? 5000);
const deadline = Date.now() + Number(arg("--hours") ?? 24) * 3_600_000;

const workspaces = await withSystem((q) => q.many<{ id: string }>(sql`select id from workspaces`));
for (const w of workspaces) {
  const run = <T>(fn: (q: Q) => Promise<T>) => withWorkspace({ workspaceId: w.id }, fn);
  const markKnown = () => run((q) => q.exec(sql`
    update discovery_candidates c set status = 'rejected', last_error = 'already a prospect' where c.platform = 'instagram' and c.status = 'pending' and c.depth > 0
      and exists (select 1 from prospects p where lower(p.instagram_handle) = lower(c.handle) and p.merged_into is null)`));
  const seeded = await run((q) => q.many<{ id: string }>(sql`
    insert into discovery_candidates (workspace_id, platform, handle, found_via, depth)
    select ${w.id}, 'instagram', lower(instagram_handle), 'prospect', 0 from prospects
    where instagram_handle is not null and merged_into is null and archived_at is null and not is_demo and country = any(${`{${seedCountries.join(",")}}`}::text[])
    on conflict do nothing returning id`));
  await markKnown();
  const icp = await run((q) => getIcpConfig(q));
  console.log(`seeded ${seeded.length} handles from ${seedCountries.join(", ")} prospects`);

  let looked = 0, kept = 0, refreshed = 0;
  const skipped = new Map<string, number>();
  const ctx = {
    workspaceId: w.id, ws: run,
    progress: async () => Date.now() < deadline,
    log: async (level: string, m: string) => console.log(`[${level}] ${m}`),
    isDone: () => false, markDone: async () => {},
  };
  try {
    for await (const p of instagramAdapter.discover({ categories: [], cities: [], limit, hashtags: [], seedHandles: [], locations: [], customTags: {} }, ctx as never)) {
      looked++;
      const handle = p.instagram_handle!.toLowerCase();
      const known = await run((q) => q.value<boolean>(sql`select exists(select 1 from prospects where lower(instagram_handle) = ${handle} and merged_into is null)`));
      const item: NormalizedProspect = { ...p, tiktok_handle: p.tiktok_handle ?? tiktokFromBio(`${p.bio ?? ""} ${p.website ?? ""}`) };
      if (known) {
        await run((q) => ingestMany(q, { workspaceId: w.id, actorType: "system" }, [item], { icp }));
        refreshed++;
      } else {
        const v = judgeProfile({ name: p.business_name, username: handle, bio: p.bio ?? null, website: p.website ?? null, followers: p.follower_count ?? null });
        if (v.keep) {
          await run((q) => ingestMany(q, { workspaceId: w.id, actorType: "system" }, [{ ...item, category: v.category, country: v.country, state: v.state, city: v.city }], { icp }));
          kept++;
        } else {
          const r = v.reason.replace(/\d+ followers/, "too many followers").replace(/category \S+/, "category");
          skipped.set(r, (skipped.get(r) ?? 0) + 1);
        }
      }
      if (looked % 20 === 0) {
        await markKnown();
        console.log(`${looked} profiles read · ${kept} new businesses kept · ${refreshed} known refreshed · skipped: ${[...skipped].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
      }
    }
  } catch (e) {
    console.error(`stopped: ${e instanceof Error ? e.message : e}`);
  }
  console.log(`done: ${looked} profiles read · ${kept} new businesses kept · ${refreshed} known refreshed · skipped: ${[...skipped].map(([k, n]) => `${k} ${n}`).join(", ") || "none"}`);
}
process.exit(0);
