import { FlaskConical } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { experimentResults, verdict, metricCount, METRIC_FIELDS, type ExperimentRow } from "@/server/services/experiments";
import { safeRate } from "@/server/services/metrics";
import { PageHeader, Panel, Badge, EmptyState } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/dialog";
import { RateBar } from "@/components/charts";
import { fmtDate, fmtNum } from "@/lib/utils";
import { NewExperiment } from "./new-experiment";
import { setExperimentStatusAction } from "./actions";

export const metadata = { title: "Experiments" };

const KIND_LABEL = { icp: "ICP", message: "Message", channel: "Channel", offer: "Offer" };

export default async function ExperimentsPage() {
  const user = await requireUser();
  const data = await asUser(user, async (q) => {
    const exps = await q.many<ExperimentRow>(sql`select id, name, hypothesis, kind, primary_metric, status, started_at, ended_at, campaign_id from experiments order by (status = 'running') desc, created_at desc`);
    const results = [];
    for (const e of exps) results.push({ e, r: await experimentResults(q, e) });
    const campaigns = await q.many<{ id: string; name: string }>(sql`select id, name from campaigns where status <> 'archived'`);
    return { results, campaigns };
  });
  const canEdit = can(user, "member");
  return (
    <>
      <PageHeader title="Experiments" description="Test who to target, what to say and where — and let the data pick the winner." />
      <div className="space-y-4 p-4 md:p-6">
        {canEdit ? <NewExperiment campaigns={data.campaigns} /> : null}
        {data.results.length === 0 ? <Panel><EmptyState icon={<FlaskConical />} title="No experiments yet" description="Example: hair stylists vs nail techs, problem-first vs curiosity, Instagram vs WhatsApp." /></Panel> : null}
        {data.results.map(({ e, r }) => {
          const m = e.primary_metric;
          const v = verdict(r, m);
          const max = Math.max(0, ...r.map((x) => (x.contacted ? metricCount(x, m) / x.contacted : 0)));
          return (
            <Panel key={e.id} title={<span className="flex items-center gap-2">{e.name}<Badge>{KIND_LABEL[e.kind]}</Badge><Badge tone={e.status === "running" ? "success" : "neutral"} dot>{e.status}</Badge></span>}
              description={`${e.hypothesis ?? ""}${e.started_at ? ` · since ${fmtDate(e.started_at)}` : ""} · primary metric: ${METRIC_FIELDS[m].label.toLowerCase()}`}
              actions={canEdit ? (e.status === "running"
                ? <ActionButton size="xs" variant="ghost" action={setExperimentStatusAction.bind(null, e.id, "completed")}>Complete</ActionButton>
                : <ActionButton size="xs" variant="ghost" action={setExperimentStatusAction.bind(null, e.id, "running")}>Resume</ActionButton>) : null}
              padded={false}>
              <Table>
                <thead><tr><Th>Variant</Th><Th className="text-right">Contacted</Th><Th>{METRIC_FIELDS[m].label}</Th><Th className="hidden md:table-cell">Reply rate</Th><Th className="hidden md:table-cell">Signup rate</Th><Th className="hidden text-right lg:table-cell">Activated</Th></tr></thead>
                <tbody>{r.map((x) => (
                  <Tr key={x.id}>
                    <Td><span className="font-medium">{x.key}</span> — {x.name}{v.status === "leading" && v.leader === x.key ? <Badge tone="success" className="ml-2">Winner</Badge> : null}</Td>
                    <Td className="text-right tabular">{fmtNum(x.contacted)}</Td>
                    <Td><RateBar rate={safeRate(metricCount(x, m), x.contacted)} max={max} lowSample={x.contacted < 30} /></Td>
                    <Td className="hidden tabular md:table-cell">{safeRate(x.replied, x.contacted) == null ? "—" : `${((x.replied / x.contacted) * 100).toFixed(1)}%`}</Td>
                    <Td className="hidden tabular md:table-cell">{safeRate(x.signed_up, x.contacted) == null ? "—" : `${((x.signed_up / x.contacted) * 100).toFixed(1)}%`}</Td>
                    <Td className="hidden text-right tabular lg:table-cell">{fmtNum(x.activated)}</Td>
                  </Tr>
                ))}</tbody>
              </Table>
              <p className={`border-t border-border px-4 py-2.5 text-[12.5px] ${v.status === "leading" ? "text-success" : "text-fg-2"}`}>{v.message}</p>
            </Panel>
          );
        })}
      </div>
    </>
  );
}
