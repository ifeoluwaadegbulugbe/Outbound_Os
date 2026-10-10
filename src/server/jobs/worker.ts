import os from "node:os";
import { withWorkspace, withSystem, sql, type Q } from "../db";
import type { Driver } from "../db/driver";
import { claimNext, completeJob, failJob, setProgress, jobLog, enqueue, type JobRow } from "./queue";
import { HANDLERS } from "./handlers";
import { ensureEmailDefaults } from "../services/workspace-defaults";

export interface JobContext {
  job: JobRow;
  workspaceId: string;
  userId: string | null;
  /** Workspace-scoped transaction. Keep transactions short; call per batch. */
  ws<T>(fn: (q: Q) => Promise<T>): Promise<T>;
  progress(current: number, total?: number | null, label?: string): Promise<boolean>;
  log(level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): Promise<void>;
}

export class JobCancelled extends Error {
  constructor() {
    super("Cancelled");
  }
}

const WORKER_ID = `${os.hostname()}:${process.pid}`;

/** Process jobs until none are ready or the time budget is used. */
export async function drain(opts: { maxJobs?: number; timeBudgetMs?: number; driver?: Driver } = {}): Promise<number> {
  const deadline = Date.now() + (opts.timeBudgetMs ?? 50_000);
  let done = 0;
  while (done < (opts.maxJobs ?? 100) && Date.now() < deadline) {
    const job = await claimNext(WORKER_ID, opts.driver);
    if (!job) break;
    await runJob(job, opts.driver);
    done++;
  }
  return done;
}

export async function runJob(job: JobRow, driver?: Driver): Promise<void> {
  const handler = HANDLERS[job.type];
  if (!handler) {
    await failJob({ ...job, attempts: job.max_attempts }, `No handler for job type ${job.type}`, driver);
    return;
  }
  const ctx: JobContext = {
    job,
    workspaceId: job.workspace_id,
    userId: job.created_by,
    ws: (fn) => withWorkspace({ workspaceId: job.workspace_id, userId: job.created_by }, fn, driver),
    progress: async (c, t, l) => {
      const ok = await setProgress(job.workspace_id, job.id, c, t ?? null, l, driver);
      if (!ok) throw new JobCancelled();
      return ok;
    },
    log: (level, m, d) => jobLog(job.workspace_id, job.id, level, m, d, driver),
  };
  try {
    const result = await handler(ctx);
    await completeJob(job.id, result, driver);
  } catch (e) {
    if (e instanceof JobCancelled) {
      await withSystem((q) => q.exec(sql`update jobs set status = 'cancelled', finished_at = now(), locked_at = null where id = ${job.id}`), driver);
      if (job.type === "discovery.run" && job.payload.runId) {
        // Paused runs keep their checkpoint; anything still "running" was cancelled.
        await withWorkspace({ workspaceId: job.workspace_id }, (q) => q.exec(sql`update discovery_runs set status = 'cancelled', finished_at = now() where id = ${String(job.payload.runId)} and status = 'running'`), driver);
      }
      await ctx.log("warn", "Cancelled by user");
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[job ${job.type} ${job.id}]`, e);
    await ctx.log("error", msg).catch(() => {});
    const willRetry = await failJob(job, msg, driver);
    if (!willRetry) await onFinalFailure(job, msg, driver);
  }
}

async function onFinalFailure(job: JobRow, msg: string, driver?: Driver) {
  await withWorkspace({ workspaceId: job.workspace_id }, async (q) => {
    await q.exec(sql`insert into notifications (workspace_id, user_id, type, title, body, link)
      values (${job.workspace_id}, ${job.created_by}, 'job_failed', ${`Background job failed: ${job.type}`}, ${msg.slice(0, 300)}, '/settings/system')`);
    if (job.type === "discovery.run" && job.payload.runId) {
      await q.exec(sql`update discovery_runs set status = 'failed', error = ${msg.slice(0, 500)}, finished_at = now() where id = ${String(job.payload.runId)}`);
    }
    if (job.type === "messages.generate" && job.payload.batchId) {
      await q.exec(sql`update outreach_batches set status = 'failed' where id = ${String(job.payload.batchId)}`);
    }
  }, driver);
}

/** Recurring work: enqueue periodic jobs (deduped, so safe to call often). */
export async function scheduleRecurring(driver?: Driver): Promise<void> {
  const workspaces = await withSystem((q) => q.many<{ id: string }>(sql`select id from workspaces`), driver);
  const hour = new Date().toISOString().slice(0, 13);
  const day = new Date().toISOString().slice(0, 10);
  for (const w of workspaces) {
    await withWorkspace({ workspaceId: w.id }, async (q) => {
      // Defaults (locations, country rules, integrations) only need seeding once; skip the dozens of
      // idempotent inserts when they're already there (this runs every minute on serverless).
      const seeded = await q.value<boolean>(sql`select exists(select 1 from locations) and exists(select 1 from country_policies)`);
      if (!seeded) await ensureEmailDefaults(q, w.id);
      await enqueue(q, { workspaceId: w.id, type: "followups.tick", dedupeKey: `followups.tick:${hour}`, once: true, maxAttempts: 2 });
      await enqueue(q, { workspaceId: w.id, type: "analytics.snapshot", dedupeKey: `analytics.snapshot:${day}`, once: true, maxAttempts: 2 });
      // Poll connected mailboxes for replies & bounces every ~10 minutes.
      const slot = Math.floor(Date.now() / 600_000);
      const accounts = await q.many<{ id: string }>(sql`select id from sender_accounts where channel = 'email' and is_active and provider in ('gmail','microsoft') and status <> 'needs_reconnect'`);
      for (const a of accounts) await enqueue(q, { workspaceId: w.id, type: "email.sync", payload: { accountId: a.id }, dedupeKey: `email.sync:${a.id}:${slot}`, once: true, maxAttempts: 1 });
    }, driver);
  }
}

const g = globalThis as unknown as { __obWorker?: { stop: () => void } };

/**
 * In-process worker loop (dev, and single-instance deployments). Polls every
 * 2s; schedules recurring jobs every 5 minutes. Use `npm run worker` or the
 * cron route instead when running several app instances.
 */
export function startInProcessWorker(): void {
  if (g.__obWorker) return;
  let stopped = false;
  let lastSchedule = 0;
  let lastDispatch = 0;
  const loop = async () => {
    while (!stopped) {
      try {
        if (Date.now() - lastSchedule > 5 * 60_000) {
          lastSchedule = Date.now();
          await scheduleRecurring();
        }
        // Send-queue dispatcher: one email per account per tick, respecting caps/intervals.
        if (Date.now() - lastDispatch > 30_000) {
          lastDispatch = Date.now();
          const { dispatchAllWorkspaces } = await import("../email/send");
          await dispatchAllWorkspaces();
        }
        const n = await drain({ maxJobs: 5, timeBudgetMs: 20_000 });
        if (n === 0) await new Promise((r) => setTimeout(r, 2000));
      } catch (e) {
        console.error("[worker] loop error", e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  // Collection runs in its own loop so long discovery/crawl batches never delay jobs or email dispatch.
  const collectionLoop = async () => {
    const { runCollectTick, runCrawlTick, runEmailCheckTick, getCollectionSettings } = await import("../collection/engine");
    while (!stopped) {
      let worked = false;
      try {
        const active = await withSystem((q) => q.many<{ id: string }>(sql`
          select id from workspaces where coalesce((settings->'collection'->>'active')::boolean, false) and not coalesce((settings->'collection'->>'paused')::boolean, false)`));
        for (const w of active) {
          const settings = await withWorkspace({ workspaceId: w.id }, (q) => getCollectionSettings(q, w.id));
          // Sources, crawler and email checks run side by side; a slow source never blocks the others.
          const results = await Promise.all([
            ...settings.sources.map((s) => runCollectTick(w.id, { budgetMs: 60_000, sources: [s] }).then((r) => r.units)),
            runCrawlTick(w.id, { budgetMs: 60_000 }).then((r) => r.crawled),
            runEmailCheckTick(w.id, { budgetMs: 30_000 }),
            import("../collection/instagram-enrich").then((m) => m.runInstagramEnrichTick(w.id, { budgetMs: 60_000, countries: settings.countries })).then((r) => r.checked),
          ]);
          worked ||= results.some((n) => n > 0);
        }
      } catch (e) {
        console.error("[worker] collection error", e);
      }
      await new Promise((r) => setTimeout(r, worked ? 1000 : 30_000));
    }
  };
  g.__obWorker = { stop: () => (stopped = true) };
  void loop();
  void collectionLoop();
  console.log("[worker] in-process job worker started");
}
