import { sql, json, withSystem, withWorkspace, type Q } from "../db";
import type { Driver } from "../db/driver";

/**
 * Postgres-backed job queue. Jobs are claimed with FOR UPDATE SKIP LOCKED so
 * any number of workers can run safely in parallel; failures retry with
 * exponential backoff; progress and cancellation are visible in the UI.
 */

export interface JobRow {
  id: string;
  workspace_id: string;
  type: string;
  status: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
  created_by: string | null;
}

export interface EnqueueOptions {
  workspaceId: string;
  type: string;
  payload?: Record<string, unknown>;
  createdBy?: string | null;
  runAt?: Date;
  maxAttempts?: number;
  /** Prevents duplicate queued/running jobs with the same key. */
  dedupeKey?: string;
  /** With dedupeKey: skip if a job with this key ever ran (time-slotted keys like `x:${hour}`). */
  once?: boolean;
  total?: number | null;
  label?: string;
}

export async function enqueue(q: Q, o: EnqueueOptions): Promise<string | null> {
  if (o.once && o.dedupeKey) {
    const seen = await q.value<boolean>(sql`select exists(select 1 from jobs where workspace_id = ${o.workspaceId} and dedupe_key = ${o.dedupeKey})`);
    if (seen) return null;
  }
  const row = await q.maybe<{ id: string }>(sql`
    insert into jobs (workspace_id, type, payload, created_by, run_at, max_attempts, dedupe_key, progress_total, progress_label)
    values (${o.workspaceId}, ${o.type}, ${json(o.payload ?? {})}, ${o.createdBy ?? null}, ${o.runAt ?? new Date()}, ${o.maxAttempts ?? 3},
            ${o.dedupeKey ?? null}, ${o.total ?? null}, ${o.label ?? null})
    on conflict do nothing
    returning id`);
  return row?.id ?? null;
}

export async function claimNext(workerId: string, driver?: Driver): Promise<JobRow | null> {
  return withSystem(async (q) => {
    // Recover jobs whose worker died mid-run.
    await q.exec(sql`update jobs set status = 'queued', locked_at = null, locked_by = null
                     where status = 'running' and locked_at < now() - interval '15 minutes'`);
    return q.maybe<JobRow>(sql`
      update jobs set status = 'running', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1,
                      started_at = coalesce(started_at, now())
      where id = (
        select id from jobs where status = 'queued' and run_at <= now()
        order by run_at, created_at limit 1
        for update skip locked)
      returning id, workspace_id, type, status, payload, attempts, max_attempts, created_by`);
  }, driver);
}

export async function completeJob(id: string, result: unknown, driver?: Driver) {
  await withSystem((q) => q.exec(sql`update jobs set status = 'succeeded', result = ${json(result ?? null)}, finished_at = now(), locked_at = null where id = ${id}`), driver);
}

export async function failJob(job: JobRow, error: string, driver?: Driver) {
  const retry = job.attempts < job.max_attempts;
  const delaySec = Math.min(3600, 30 * 2 ** (job.attempts - 1));
  await withSystem((q) => q.exec(sql`
    update jobs set status = ${retry ? "queued" : "failed"}, last_error = ${error.slice(0, 2000)}, locked_at = null, locked_by = null,
      run_at = ${retry ? new Date(Date.now() + delaySec * 1000) : new Date()}, finished_at = ${retry ? null : new Date()}
    where id = ${job.id}`), driver);
  return retry;
}

export async function cancelJob(q: Q, id: string) {
  await q.exec(sql`update jobs set cancel_requested = true, status = case when status = 'queued' then 'cancelled' else status end,
                   finished_at = case when status = 'queued' then now() else finished_at end where id = ${id}`);
}

export async function setProgress(workspaceId: string, jobId: string, current: number, total: number | null, label: string | undefined, driver?: Driver): Promise<boolean> {
  return withWorkspace({ workspaceId }, async (q) => {
    const r = await q.maybe<{ cancel_requested: boolean }>(sql`
      update jobs set progress_current = ${current}, progress_total = coalesce(${total}, progress_total), progress_label = coalesce(${label ?? null}, progress_label)
      where id = ${jobId} returning cancel_requested`);
    return !r?.cancel_requested;
  }, driver);
}

export async function jobLog(workspaceId: string, jobId: string, level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>, driver?: Driver) {
  await withWorkspace({ workspaceId }, (q) => q.exec(sql`insert into job_logs (workspace_id, job_id, level, message, data) values (${workspaceId}, ${jobId}, ${level}, ${message.slice(0, 1000)}, ${json(data ?? null)})`), driver);
}
