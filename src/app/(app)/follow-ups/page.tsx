import Link from "next/link";
import { CalendarClock } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { PageHeader, Panel, EmptyState, Badge, ScoreBadge } from "@/components/ui/display";
import { ChannelLabel, MessageStatusBadge } from "@/components/ui/status";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/dialog";
import { LinkButton } from "@/components/ui/button";
import { fmtDate, timeAgo } from "@/lib/utils";
import { draftDueFollowupsAction } from "./actions";

export const metadata = { title: "Follow-ups" };

type Row = { id: string; prospect_id: string; business_name: string; icp_score: number | null; step: number; due_at: Date; channel: string | null; campaign: string | null; message_status: string | null; last_contacted_at: Date | null };

export default async function FollowupsPage() {
  const user = await requireUser();
  const data = await asUser(user, async (q) => {
    const rows = await q.many<Row>(sql`
      select f.id, f.prospect_id, p.business_name, p.icp_score, f.step, f.due_at, f.channel, c.name as campaign, m.status as message_status, p.last_contacted_at
      from followups f join prospects p on p.id = f.prospect_id left join campaigns c on c.id = f.campaign_id left join outreach_messages m on m.id = f.message_id
      where f.status = 'pending' and f.due_at < now() + interval '7 days'
      order by f.due_at limit 300`);
    const stats = await q.one<{ done: number; cancelled_reply: number; cancelled_other: number }>(sql`
      select count(*) filter (where status = 'done')::int as done,
             count(*) filter (where status = 'cancelled' and cancel_reason like 'replied%')::int as cancelled_reply,
             count(*) filter (where status = 'cancelled' and cancel_reason not like 'replied%')::int as cancelled_other
      from followups where created_at > now() - interval '30 days'`);
    const sequence = await q.maybe<{ name: string; steps: { day: number; angle: string; instructions?: string }[] }>(sql`select name, steps from followup_sequences where is_default limit 1`);
    return { rows, stats, sequence };
  });
  const now = Date.now();
  const startOfTomorrow = new Date(); startOfTomorrow.setHours(24, 0, 0, 0);
  const groups: [string, Row[]][] = [
    ["Overdue", data.rows.filter((r) => new Date(r.due_at).getTime() < now - 3_600_000)],
    ["Due today", data.rows.filter((r) => new Date(r.due_at).getTime() >= now - 3_600_000 && new Date(r.due_at) < startOfTomorrow)],
    ["Next 7 days", data.rows.filter((r) => new Date(r.due_at) >= startOfTomorrow)],
  ];

  return (
    <>
      <PageHeader title="Follow-ups" description="Sequences run automatically after a first message and stop the moment someone replies, converts or opts out."
        actions={can(user, "member") ? <ActionButton size="sm" variant="primary" action={draftDueFollowupsAction}>Draft due follow-ups now</ActionButton> : null} />
      <div className="grid gap-4 p-4 md:p-6 xl:grid-cols-[1fr_300px]">
        <div className="space-y-4">
          {data.rows.length === 0 ? <Panel><EmptyState icon={<CalendarClock />} title="No follow-ups due" description="They're scheduled automatically when you mark a first message as sent." /></Panel> : null}
          {groups.filter(([, rows]) => rows.length).map(([label, rows]) => (
            <Panel key={label} title={`${label} · ${rows.length}`} padded={false}>
              <Table>
                <thead><tr><Th>Prospect</Th><Th>Step</Th><Th>Channel</Th><Th>Due</Th><Th className="hidden md:table-cell">Last contact</Th><Th>Draft</Th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <Tr key={r.id}>
                      <Td><Link href={`/prospects/${r.prospect_id}`} className="font-medium hover:underline">{r.business_name}</Link> <ScoreBadge score={r.icp_score} className="ml-1" />{r.campaign ? <div className="text-[11.5px] text-fg-3">{r.campaign}</div> : null}</Td>
                      <Td>{r.step >= 9 ? <Badge>Check-in</Badge> : `Step ${r.step}`}</Td>
                      <Td><ChannelLabel channel={r.channel} /></Td>
                      <Td className="whitespace-nowrap text-[12px]">{fmtDate(r.due_at, "EEE d MMM, HH:mm")}</Td>
                      <Td className="hidden text-[12px] text-fg-3 md:table-cell">{timeAgo(r.last_contacted_at)}</Td>
                      <Td>{r.message_status ? <Link href="/outreach"><MessageStatusBadge status={r.message_status} /></Link> : <span className="text-[12px] text-fg-3">Drafted ~12h before due</span>}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          ))}
        </div>
        <div className="space-y-4">
          <Panel title="Sequence" actions={<LinkButton href="/settings/sequences" size="xs" variant="ghost">Edit</LinkButton>}>
            <p className="text-[12.5px] font-medium">{data.sequence?.name ?? "Default"}</p>
            <ol className="mt-2 space-y-2 text-[12.5px]">
              <li><span className="text-fg-3">Day 0 ·</span> First message</li>
              {(data.sequence?.steps ?? []).map((s, i) => <li key={i}><span className="text-fg-3">Day {s.day} ·</span> {s.instructions ?? s.angle}</li>)}
            </ol>
          </Panel>
          <Panel title="Last 30 days">
            <ul className="space-y-1.5 text-[12.5px]">
              <li className="flex justify-between"><span className="text-fg-3">Follow-ups sent</span><span className="tabular">{data.stats.done}</span></li>
              <li className="flex justify-between"><span className="text-fg-3">Stopped by a reply</span><span className="tabular">{data.stats.cancelled_reply}</span></li>
              <li className="flex justify-between"><span className="text-fg-3">Stopped (opt-out, converted…)</span><span className="tabular">{data.stats.cancelled_other}</span></li>
            </ul>
          </Panel>
        </div>
      </div>
    </>
  );
}
