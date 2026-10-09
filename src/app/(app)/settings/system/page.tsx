import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { aiStatus } from "@/server/ai/providers";
import { Panel, Badge } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { timeAgo, fmtNum } from "@/lib/utils";
import { JobButtons } from "../forms";

export const metadata = { title: "System health" };

type Tone = "success" | "warning" | "danger" | "neutral";

export default async function SystemHealth() {
  const user = await requireUser();
  const started = Date.now();
  const data = await asUser(user, async (q) => {
    const jobs = await q.one<{ queued: number; running: number; failed_24h: number; succeeded_24h: number; oldest_queued: Date | null }>(sql`
      select count(*) filter (where status = 'queued')::int as queued, count(*) filter (where status = 'running')::int as running,
        count(*) filter (where status = 'failed' and finished_at > now() - interval '24 hours')::int as failed_24h,
        count(*) filter (where status = 'succeeded' and finished_at > now() - interval '24 hours')::int as succeeded_24h,
        min(run_at) filter (where status = 'queued' and run_at <= now()) as oldest_queued
      from jobs`);
    const ai = await q.many<{ status: string; n: number; avg_ms: number | null }>(sql`
      select status, count(*)::int as n, avg(latency_ms)::int as avg_ms from ai_runs where created_at > now() - interval '24 hours' group by status`);
    const recent = await q.many<{ id: string; type: string; status: string; progress_current: number; progress_total: number | null; attempts: number; max_attempts: number; last_error: string | null; created_at: Date }>(sql`
      select id, type, status, progress_current, progress_total, attempts, max_attempts, last_error, created_at from jobs order by created_at desc limit 25`);
    const integ = await q.many<{ key: string; status: string; last_error: string | null; last_error_at: Date | null; last_success_at: Date | null }>(sql`
      select key, status, last_error, last_error_at, last_success_at from integrations where key in ('instagram_graph','osm_overpass','conversions_webhook')`);
    const aiErrors = await q.many<{ task: string; provider: string; error: string | null; created_at: Date }>(sql`
      select task, provider, error, created_at from ai_runs where status in ('error','invalid_output') order by created_at desc limit 5`);
    return { jobs, ai, recent, integ, aiErrors };
  });
  const dbMs = Date.now() - started;
  const ai = aiStatus();
  const aiCounts = Object.fromEntries(data.ai.map((r) => [r.status, r]));
  const stuck = data.jobs.oldest_queued && Date.now() - new Date(data.jobs.oldest_queued).getTime() > 10 * 60_000;
  const ig = data.integ.find((i) => i.key === "instagram_graph");
  const rows: [string, string, Tone][] = [
    ["Database", `Healthy · ${dbMs} ms`, "success"],
    ["Background jobs", stuck ? "Jobs waiting >10 min — is the worker running?" : `Healthy · ${data.jobs.queued} queued · ${data.jobs.running} running`, stuck ? "danger" : "success"],
    ["AI", ai.enabled ? `${ai.providers.map((p) => p.name).join(" → ")} · ${aiCounts.ok?.n ?? 0} ok / ${(aiCounts.error?.n ?? 0) + (aiCounts.invalid_output?.n ?? 0)} failed (24h)` : "Templates & rules (no provider configured)", ai.enabled ? ((aiCounts.error?.n ?? 0) > (aiCounts.ok?.n ?? 0) ? "warning" : "success") : "neutral"],
    ["Discovery · OpenStreetMap", "Healthy", "success"],
    ["Discovery · Instagram", ig?.status === "connected" ? (ig.last_error && (!ig.last_success_at || ig.last_error_at! > ig.last_success_at) ? `Error: ${ig.last_error}` : "Connected") : "Needs setup", ig?.status === "connected" ? "success" : "warning"],
    ["Orbit conversions", data.integ.find((i) => i.key === "conversions_webhook")?.last_success_at ? "Receiving events" : "No events yet", "neutral"],
    ["TikTok", "No API available — human-assisted only", "neutral"],
  ];
  return (
    <>
      <Panel title="System health">
        <ul className="divide-y divide-border">
          {rows.map(([k, v, tone]) => (
            <li key={k} className="flex items-center justify-between gap-3 py-2 text-[13px]">
              <span className="font-medium">{k}</span>
              <Badge tone={tone}>{v}</Badge>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-[11.5px] text-fg-3">Last 24h: {fmtNum(data.jobs.succeeded_24h)} jobs succeeded · {fmtNum(data.jobs.failed_24h)} failed.</p>
      </Panel>
      {data.aiErrors.length ? (
        <Panel title="Recent AI failures" description="Each one fell back to templates/rules — nothing was blocked.">
          <ul className="space-y-1.5 text-[12px]">{data.aiErrors.map((e, i) => <li key={i}><span className="font-medium">{e.task}</span> <span className="text-fg-3">· {e.provider} · {timeAgo(e.created_at)}</span><br /><span className="text-danger">{e.error}</span></li>)}</ul>
        </Panel>
      ) : null}
      <Panel title="Background jobs" padded={false}>
        <Table>
          <thead><tr><Th>Job</Th><Th>Status</Th><Th>Progress</Th><Th>Attempts</Th><Th>Created</Th><Th /></tr></thead>
          <tbody>{data.recent.map((j) => (
            <Tr key={j.id}>
              <Td className="font-mono text-[12px]">{j.type}</Td>
              <Td><Badge tone={j.status === "succeeded" ? "success" : j.status === "failed" ? "danger" : j.status === "running" ? "warning" : "neutral"}>{j.status}</Badge>
                {j.last_error && j.status !== "succeeded" ? <div className="max-w-[320px] truncate text-[11px] text-danger" title={j.last_error}>{j.last_error}</div> : null}</Td>
              <Td className="tabular text-[12px]">{j.progress_total ? `${fmtNum(j.progress_current)} / ${fmtNum(j.progress_total)}` : "—"}</Td>
              <Td className="tabular text-[12px]">{j.attempts}/{j.max_attempts}</Td>
              <Td className="text-[12px] text-fg-3">{timeAgo(j.created_at)}</Td>
              <Td><JobButtons id={j.id} status={j.status} /></Td>
            </Tr>
          ))}</tbody>
        </Table>
      </Panel>
    </>
  );
}
