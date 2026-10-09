import { sql, json, textArray } from "../db";
import type { JobContext } from "./worker";
import { generateDraft, refreshNextFollowup } from "../services/outreach";
import { funnel } from "../services/metrics";
import { runDiscovery } from "../services/discovery";
import { runImport } from "../services/importer";
import { researchProspect } from "../services/research";
import { getIcpConfig, rescoreProspect } from "../services/scoring-service";
import { scanDuplicates } from "../services/dedup-scan";
import { notify } from "../services/audit";
import { enrichProspectEmail, verifyAndStore } from "../email/enrich";
import { syncAccount } from "../email/sync";

export type JobHandler = (ctx: JobContext) => Promise<unknown>;

/**
 * NOTE: never call ctx.progress()/ctx.log() inside ctx.ws(): on the embedded
 * database those open their own transaction and would wait on the outer one.
 */
export const HANDLERS: Record<string, JobHandler> = {
  async "messages.generate"(ctx) {
    const p = ctx.job.payload as { batchId: string; prospectIds: string[]; channel: string; campaignId: string | null; angle?: string | null };
    const senderName = await ctx.ws((q) => q.value<string | null>(sql`select name from users where id = ${ctx.userId}`));
    await ctx.ws((q) => q.exec(sql`update outreach_batches set status = 'generating' where id = ${p.batchId}`));
    let generated = 0, blocked = 0, skipped = 0;
    const reasons: Record<string, number> = {};
    for (let i = 0; i < p.prospectIds.length; i++) {
      if (i % 5 === 0) await ctx.progress(i, p.prospectIds.length, `Drafting ${i + 1} of ${p.prospectIds.length}`);
      try {
        const r = await generateDraft(ctx.ws, { workspaceId: ctx.workspaceId, actorType: "ai", actorId: null, senderName }, {
          prospectId: p.prospectIds[i], campaignId: p.campaignId, channel: p.channel, angle: p.angle ?? null, batchId: p.batchId,
        });
        if (r.status === "needs_review") generated++;
        else if (r.status === "blocked") blocked++;
        else {
          skipped++;
          reasons[r.reason ?? "skipped"] = (reasons[r.reason ?? "skipped"] ?? 0) + 1;
        }
      } catch (e) {
        skipped++;
        reasons.error = (reasons.error ?? 0) + 1;
        await ctx.log("warn", `Draft failed for ${p.prospectIds[i]}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (i % 10 === 9) await ctx.ws((q) => q.exec(sql`update outreach_batches set generated = ${generated}, blocked = ${blocked} where id = ${p.batchId}`));
    }
    await ctx.progress(p.prospectIds.length, p.prospectIds.length, "Done");
    await ctx.ws(async (q) => {
      await q.exec(sql`update outreach_batches set status = 'ready', generated = ${generated}, blocked = ${blocked}, params = params || ${json({ skipped, reasons })} where id = ${p.batchId}`);
      await notify(q, ctx.workspaceId, { userId: ctx.userId, type: "batch_ready", title: `${generated} messages ready for review`, body: `${blocked} blocked by the safety check · ${skipped} skipped`, link: `/outreach?batch=${p.batchId}` });
    });
    return { generated, blocked, skipped, reasons };
  },

  async "followups.tick"(ctx) {
    // 1) Stop sequences that should no longer run.
    const cancelled = await ctx.ws(async (q) => {
      const rows = await q.many<{ id: string; prospect_id: string }>(sql`
        update followups f set status = 'cancelled', cancel_reason = case
            when p.do_not_contact then 'do_not_contact' when p.signed_up then 'converted' when p.replied_at is not null then 'replied'
            else 'not_contactable' end
        from prospects p
        where p.id = f.prospect_id and f.status = 'pending' and f.step < 9
          and (p.do_not_contact or p.signed_up or p.status in ('NOT_INTERESTED','LOST','DO_NOT_CONTACT') or (p.replied_at is not null and p.replied_at > f.created_at))
        returning f.id, f.prospect_id`);
      for (const r of rows) await refreshNextFollowup(q, r.prospect_id);
      return rows.length;
    });
    // 2) Draft follow-ups due within the next 12 hours.
    const due = await ctx.ws((q) => q.many<{ id: string; prospect_id: string; campaign_id: string | null; step: number; channel: string | null; steps: { day: number; angle: string; instructions?: string }[] | null }>(sql`
      select f.id, f.prospect_id, f.campaign_id, f.step, f.channel, s.steps
      from followups f left join followup_sequences s on s.id = f.sequence_id
      where f.status = 'pending' and f.message_id is null and f.due_at <= now() + interval '12 hours'
        and not (select outreach_paused from workspaces where id = f.workspace_id)
        and (f.campaign_id is null or exists (select 1 from campaigns c where c.id = f.campaign_id and c.status = 'active'))
      order by f.due_at limit 200`));
    const senderName = await ctx.ws((q) => q.value<string | null>(sql`select u.name from workspace_members m join users u on u.id = m.user_id where m.role = 'owner' order by m.created_at limit 1`));
    let drafted = 0;
    for (const [i, f] of due.entries()) {
      if (i % 10 === 0) await ctx.progress(i, due.length, "Drafting follow-ups");
      const stepDef = f.steps?.[f.step - 1];
      const r = await generateDraft(ctx.ws, { workspaceId: ctx.workspaceId, actorType: "ai", actorId: null, senderName }, {
        prospectId: f.prospect_id, campaignId: f.campaign_id, channel: f.channel, angle: stepDef?.angle ?? "bump", kind: "followup", step: Math.min(f.step, 3),
        followupId: f.id, followupInstructions: stepDef?.instructions ?? null,
      });
      if (r.messageId) drafted++;
    }
    return { cancelled, drafted, due: due.length };
  },

  async "analytics.snapshot"(ctx) {
    const day = new Date().toISOString().slice(0, 10);
    await ctx.ws(async (q) => {
      const all = await funnel(q);
      await q.exec(sql`insert into analytics_snapshots (workspace_id, snapshot_date, campaign_id, metrics) values (${ctx.workspaceId}, ${day}, null, ${json(all)})
                       on conflict (workspace_id, snapshot_date, coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set metrics = excluded.metrics`);
      const campaigns = await q.many<{ id: string }>(sql`select id from campaigns where status in ('active','paused')`);
      for (const c of campaigns) {
        const f = await funnel(q, { campaignId: c.id });
        await q.exec(sql`insert into analytics_snapshots (workspace_id, snapshot_date, campaign_id, metrics) values (${ctx.workspaceId}, ${day}, ${c.id}, ${json(f)})
                         on conflict (workspace_id, snapshot_date, coalesce(campaign_id, '00000000-0000-0000-0000-000000000000'::uuid)) do update set metrics = excluded.metrics`);
      }
    });
    return { day };
  },

  "discovery.run": (ctx) => runDiscovery(ctx),
  "import.csv": (ctx) => runImport(ctx),

  async "research.bulk"(ctx) {
    const ids = (ctx.job.payload.prospectIds as string[]) ?? [];
    let done = 0;
    for (const id of ids) {
      if (done % 5 === 0) await ctx.progress(done, ids.length, "Researching prospects");
      await researchProspect(ctx.ws, ctx.workspaceId, id);
      done++;
    }
    return { done };
  },

  async "prospects.rescore"(ctx) {
    const ids = await ctx.ws((q) => q.many<{ id: string }>(sql`select id from prospects where merged_into is null and archived_at is null`));
    const icp = await ctx.ws((q) => getIcpConfig(q));
    for (let i = 0; i < ids.length; i += 100) {
      await ctx.progress(i, ids.length, "Re-scoring");
      const chunk = ids.slice(i, i + 100);
      await ctx.ws(async (q) => {
        for (const r of chunk) await rescoreProspect(q, r.id, icp);
      });
    }
    return { rescored: ids.length };
  },

  "dedupe.scan": (ctx) => scanDuplicates(ctx),

  /** Find public emails on business websites + verify. Resumable via a cursor. */
  async "enrich.emails"(ctx) {
    const pl = ctx.job.payload as { prospectIds: string[]; force?: boolean; cursor?: number };
    const ids = pl.prospectIds ?? [];
    const tally: Record<string, number> = { found: 0, already_had: 0, none_found: 0, no_website: 0, error: 0 };
    for (let i = pl.cursor ?? 0; i < ids.length; i++) {
      if (i % 3 === 0) await ctx.progress(i, ids.length, `Checking websites · ${tally.found} emails found`);
      const r = await enrichProspectEmail(ctx.ws, ctx.workspaceId, ids[i], { force: pl.force });
      tally[r.outcome] = (tally[r.outcome] ?? 0) + 1;
      if (i % 10 === 9) await ctx.ws((q) => q.exec(sql`update jobs set payload = payload || ${json({ cursor: i + 1 })} where id = ${ctx.job.id}`));
    }
    await ctx.progress(ids.length, ids.length, `Done · ${tally.found} new emails`);
    await ctx.ws((q) => notify(q, ctx.workspaceId, { userId: ctx.userId, type: "enrich_done", title: `Email search finished: ${tally.found} new emails found`,
      body: `${ids.length} checked · ${tally.none_found} had no public email · ${tally.no_website} without a website · ${tally.error} errors`, link: "/prospects?view=email" }));
    return tally;
  },

  async "enrich.verify"(ctx) {
    const ids = (ctx.job.payload.prospectIds as string[]) ?? [];
    const tally: Record<string, number> = {};
    for (let i = 0; i < ids.length; i++) {
      if (i % 5 === 0) await ctx.progress(i, ids.length, "Verifying emails");
      const r = await verifyAndStore(ctx.ws, ctx.workspaceId, ids[i]);
      const k = r?.status ?? "none";
      tally[k] = (tally[k] ?? 0) + 1;
    }
    return tally;
  },

  async "email.sync"(ctx) {
    const accountId = String(ctx.job.payload.accountId);
    const r = await syncAccount(ctx.workspaceId, accountId);
    if (r.error) await ctx.log("warn", `Sync error: ${r.error}`);
    return r;
  },

  async "prospects.add_to_campaign"(ctx) {
    const p = ctx.job.payload as { campaignId: string; prospectIds: string[] };
    const n = await ctx.ws((q) => q.many(sql`insert into campaign_prospects (workspace_id, campaign_id, prospect_id)
      select ${ctx.workspaceId}, ${p.campaignId}, unnest(${textArray(p.prospectIds)}::uuid[]) on conflict do nothing returning prospect_id`));
    return { added: n.length };
  },
};
