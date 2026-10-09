import Link from "next/link";
import { Plus, Target } from "lucide-react";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { PageHeader, Panel, EmptyState, Badge, Progress } from "@/components/ui/display";
import { LinkButton } from "@/components/ui/button";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { categoryLabel, CHANNEL_LABELS, type Channel } from "@/server/domain/taxonomy";
import { fmtNum, fmtPct, fmtDate } from "@/lib/utils";

export const metadata = { title: "Campaigns" };

const STATUS_TONE = { draft: "neutral", active: "success", paused: "warning", completed: "info", archived: "neutral" } as const;

export default async function CampaignsPage() {
  const user = await requireUser();
  const rows = await asUser(user, (q) => q.many<{
    id: string; name: string; status: keyof typeof STATUS_TONE; categories: string[]; cities: string[]; channels: string[]; prospect_goal: number | null; end_date: Date | null;
    prospects: number; qualified: number; contacted: number; replied: number; signed_up: number; activated: number;
  }>(sql`
    select c.id, c.name, c.status, c.categories, c.cities, c.channels, c.prospect_goal, c.end_date,
      count(p.id)::int as prospects,
      count(p.id) filter (where p.qualified_at is not null)::int as qualified,
      count(p.id) filter (where p.first_contacted_at is not null)::int as contacted,
      count(p.id) filter (where p.replied_at is not null)::int as replied,
      count(p.id) filter (where p.signed_up)::int as signed_up,
      count(p.id) filter (where p.activated)::int as activated
    from campaigns c
    left join campaign_prospects cp on cp.campaign_id = c.id
    left join prospects p on p.id = cp.prospect_id and p.merged_into is null
    where c.status <> 'archived'
    group by c.id order by (c.status = 'active') desc, c.created_at desc`));

  return (
    <>
      <PageHeader title="Campaigns" description="Who you're targeting, how you'll reach them, and how it's converting."
        actions={<LinkButton href="/campaigns/new" variant="primary" size="sm"><Plus /> New campaign</LinkButton>} />
      <div className="p-4 md:p-6">
        <Panel padded={false}>
          {rows.length === 0 ? (
            <EmptyState icon={<Target />} title="No campaigns yet" description="Create your first campaign and tell the system who you're looking for."
              action={<LinkButton href="/campaigns/new" variant="primary">Create campaign</LinkButton>} />
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Campaign</Th><Th>Status</Th><Th className="hidden lg:table-cell">Target</Th><Th>Prospects</Th>
                  <Th className="hidden md:table-cell">Contacted</Th><Th className="hidden md:table-cell">Reply rate</Th><Th>Signups</Th><Th className="hidden xl:table-cell">Activated</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <Tr key={c.id}>
                    <Td className="max-w-[260px]">
                      <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">{c.name}</Link>
                      <div className="truncate text-[11.5px] text-fg-3">{c.channels.map((ch) => CHANNEL_LABELS[ch as Channel] ?? ch).join(" · ")}{c.end_date ? ` · ends ${fmtDate(c.end_date)}` : ""}</div>
                    </Td>
                    <Td><Badge tone={STATUS_TONE[c.status]} dot>{c.status}</Badge></Td>
                    <Td className="hidden max-w-[260px] lg:table-cell"><span className="line-clamp-2 text-[12px] text-fg-2">{c.categories.map(categoryLabel).join(", ") || "Any category"} · {c.cities.join(", ") || "Any city"}</span></Td>
                    <Td className="min-w-[120px]">
                      <div className="tabular text-[12.5px]">{fmtNum(c.prospects)}{c.prospect_goal ? <span className="text-fg-3"> / {fmtNum(c.prospect_goal)}</span> : null}</div>
                      {c.prospect_goal ? <Progress value={c.prospects} max={c.prospect_goal} className="mt-1 h-1" /> : null}
                    </Td>
                    <Td className="hidden tabular md:table-cell">{fmtNum(c.contacted)}</Td>
                    <Td className="hidden tabular md:table-cell">{fmtPct(c.replied, c.contacted)}</Td>
                    <Td className="tabular">{fmtNum(c.signed_up)}</Td>
                    <Td className="hidden tabular xl:table-cell">{fmtNum(c.activated)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
