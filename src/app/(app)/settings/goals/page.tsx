import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { goalProgress, type GoalRow } from "@/server/services/metrics";
import { Panel, Progress, Badge } from "@/components/ui/display";
import { ActionButton } from "@/components/ui/dialog";
import { fmtDate, fmtNum } from "@/lib/utils";
import { GoalForm } from "../forms";
import { deleteGoalAction } from "../actions";

export const metadata = { title: "Goals" };

export default async function GoalSettings() {
  const user = await requireUser();
  const data = await asUser(user, async (q) => {
    const goals = await q.many<GoalRow>(sql`select id, name, metric, target, start_date, end_date, campaign_id, geography from goals order by end_date`);
    const withP = [];
    for (const g of goals) withP.push({ g, p: await goalProgress(q, g) });
    const campaigns = await q.many<{ id: string; name: string }>(sql`select id, name from campaigns where status <> 'archived'`);
    return { withP, campaigns };
  });
  return (
    <>
      <Panel title="Goals">
        {data.withP.length === 0 ? <p className="text-[12.5px] text-fg-3">No goals yet.</p> : (
          <ul className="space-y-4">{data.withP.map(({ g, p }) => (
            <li key={g.id}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{g.name}</span><Badge>{g.metric.replace("_", " ")}</Badge>
                <span className="text-[12px] text-fg-3">{fmtDate(g.start_date)} → {fmtDate(g.end_date)}</span>
                <span className="ml-auto"><ActionButton size="xs" variant="ghost" action={deleteGoalAction.bind(null, g.id)} confirm={{ title: "Delete goal?", description: g.name }}>Delete</ActionButton></span>
              </div>
              <Progress value={p.pct} className="mt-1.5" />
              <p className="mt-1 text-[12px] tabular text-fg-3">{fmtNum(p.completed)} / {fmtNum(g.target)} · pace {fmtNum(Math.round(p.currentPace))}/day · need {fmtNum(Math.ceil(p.requiredPace))}/day · projected {fmtNum(p.projected)} · {p.status.replace("_", " ")}</p>
            </li>
          ))}</ul>
        )}
      </Panel>
      <GoalForm campaigns={data.campaigns} />
    </>
  );
}
