import { sql, json } from "../db";
import type { JobContext } from "../jobs/worker";
import { getAdapter } from "../adapters/registry";
import type { NormalizedProspect } from "../adapters/types";
import { ingestMany, type IngestOutcome } from "./ingest";
import { getIcpConfig } from "./scoring-service";
import { notify } from "./audit";
import { enqueue } from "../jobs/queue";

/**
 * Discovery job: adapter → normalize → dedupe → score → (campaign).
 * Resumable: completed work units (e.g. city × category) are checkpointed on
 * the run, so a paused/failed run continues where it stopped; records already
 * ingested are matched by source id, never duplicated.
 */
export async function runDiscovery(ctx: JobContext) {
  const p = ctx.job.payload as { runId: string; adapter: string; categories: string[]; cities: string[]; limit: number; campaignId: string | null; hashtags?: string[]; seedHandles?: string[]; findEmails?: boolean };
  const adapter = getAdapter(p.adapter);
  if (!adapter) throw new Error(`Unknown discovery source ${p.adapter}`);
  const run = await ctx.ws((q) => q.one<{ checkpoint: { done?: string[] }; found: number; created: number; merged: number; duplicates_flagged: number; skipped: number; status: string; created_at: Date }>(sql`
    select checkpoint, found, created, merged, duplicates_flagged, skipped, status, created_at from discovery_runs where id = ${p.runId}`));
  if (run.status === "cancelled" || run.status === "paused") return { skipped: run.status };
  await ctx.ws((q) => q.exec(sql`update discovery_runs set status = 'running', job_id = ${ctx.job.id}, error = null where id = ${p.runId}`));
  const icp = await ctx.ws((q) => getIcpConfig(q));
  const locations = await ctx.ws((q) => q.many<{ key: string; city: string; country_code: string; s: number; w: number; n: number; e: number }>(sql`
    select key, city, country_code, bbox_south as s, bbox_west as w, bbox_north as n, bbox_east as e from locations
    where key = any(${`{${p.cities.join(",")}}`}::text[]) and is_active`));
  const custom = await ctx.ws((q) => q.many<{ key: string; osm_tags: string[] }>(sql`select key, osm_tags from categories where is_active and cardinality(osm_tags) > 0`));
  const done = new Set<string>(run.checkpoint?.done ?? []);
  // Counters continue from previous attempts.
  const counts: Record<IngestOutcome, number> = { created: Math.max(0, run.created - run.duplicates_flagged), merged: run.merged, flagged: run.duplicates_flagged, suppressed: 0, skipped: run.skipped };
  let found = run.found;
  let buffer: NormalizedProspect[] = [];

  const flush = async () => {
    if (!buffer.length) return;
    const items = buffer;
    buffer = [];
    const r = await ctx.ws((q) => ingestMany(q, { workspaceId: ctx.workspaceId, actorType: "system" }, items, { campaignId: p.campaignId, icp }));
    for (const k of Object.keys(counts) as IngestOutcome[]) counts[k] += r.counts[k];
    const emails = items.filter((i) => i.email).length;
    await ctx.ws((q) => q.exec(sql`
      update discovery_runs set found = ${found}, created = ${counts.created + counts.flagged}, merged = ${counts.merged},
        duplicates_flagged = ${counts.flagged}, skipped = ${counts.skipped + counts.suppressed}, emails_found = emails_found + ${emails} where id = ${p.runId}`));
  };

  for await (const item of adapter.discover(
    {
      categories: p.categories, cities: p.cities, limit: Math.max(0, p.limit - found), hashtags: p.hashtags, seedHandles: p.seedHandles,
      locations: locations.map((l) => ({ key: l.key, city: l.city, country_code: l.country_code, bbox: [l.s, l.w, l.n, l.e] as [number, number, number, number] })),
      customTags: Object.fromEntries(custom.map((c) => [c.key, c.osm_tags])),
    },
    {
      workspaceId: ctx.workspaceId, ws: ctx.ws, progress: async (c, t, l) => ctx.progress(c, t, l), log: ctx.log,
      isDone: (u) => done.has(u),
      markDone: async (u) => {
        await flush(); // everything from this unit is stored before it's marked done
        done.add(u);
        await ctx.ws((q) => q.exec(sql`update discovery_runs set checkpoint = ${json({ done: [...done] })} where id = ${p.runId}`));
      },
    },
  )) {
    found++;
    buffer.push(item);
    if (buffer.length >= 25) {
      await flush();
      await ctx.progress(found, p.limit, `${found} found · ${counts.created + counts.flagged} new`);
    }
  }
  await flush();
  await ctx.progress(found, found, `Done — ${counts.created + counts.flagged} new prospects`);
  let enrichQueued = 0;
  await ctx.ws(async (q) => {
    await q.exec(sql`update discovery_runs set status = 'succeeded', finished_at = now(), params = params || ${json({ counts })} where id = ${p.runId} and status = 'running'`);
    if (p.findEmails) {
      // Follow-up step: look for public emails on the websites of businesses this run added.
      const ids = (await q.many<{ id: string }>(sql`
        select id from prospects where source = ${p.adapter} and created_at >= ${run.created_at} and website is not null
          and email is null and website_checked_at is null and not do_not_contact and not is_demo order by priority_score desc limit 5000`)).map((r) => r.id);
      if (ids.length) {
        enrichQueued = ids.length;
        await enqueue(q, { workspaceId: ctx.workspaceId, type: "enrich.emails", createdBy: ctx.userId, total: ids.length, payload: { prospectIds: ids } });
      }
    }
    await notify(q, ctx.workspaceId, {
      userId: ctx.userId, type: "discovery_done", title: `Discovery finished: ${counts.created + counts.flagged} new prospects`,
      body: `${found} found via ${adapter.info.label} · ${counts.merged} matched existing · ${counts.flagged} possible duplicates · ${counts.suppressed} suppressed${enrichQueued ? ` · searching ${enrichQueued} websites for emails` : ""}`,
      link: `/discover?tab=runs`,
    });
  });
  return { found, ...counts };
}
