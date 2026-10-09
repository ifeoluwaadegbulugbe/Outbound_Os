import Link from "next/link";
import { Layers } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { compileFilter } from "@/server/domain/filters-sql";
import { describeFilter, type FilterNode } from "@/server/domain/filters";
import { encodeJson } from "@/lib/filter-codec";
import { PageHeader, Panel, EmptyState } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { ActionButton } from "@/components/ui/dialog";
import { fmtNum, fmtPct } from "@/lib/utils";
import { SegmentBuilder } from "./builder";
import { deleteSegmentAction } from "./actions";

export const metadata = { title: "Segments" };

export default async function SegmentsPage() {
  const user = await requireUser();
  const rows = await asUser(user, async (q) => {
    const segs = await q.many<{ id: string; name: string; natural_language: string | null; rules: FilterNode }>(sql`select id, name, natural_language, rules from segments order by created_at desc`);
    const out = [];
    for (const s of segs) {
      const c = await q.one<{ n: number; contacted: number; replied: number; signed: number }>(sql`
        select count(*)::int as n, count(*) filter (where p.first_contacted_at is not null)::int as contacted,
          count(*) filter (where p.replied_at is not null)::int as replied, count(*) filter (where p.signed_up)::int as signed
        from prospects p where p.merged_into is null and ${compileFilter(s.rules)}`);
      out.push({ ...s, ...c });
    }
    return out;
  });
  return (
    <>
      <PageHeader title="Segments" description="Reusable audiences in plain English — e.g. “nail techs in Lagos with booking links, not contacted”." />
      <div className="space-y-4 p-4 md:p-6">
        {can(user, "member") ? <SegmentBuilder /> : null}
        <Panel padded={false}>
          {rows.length === 0 ? <EmptyState icon={<Layers />} title="No segments yet" description="Describe an audience above and save it." /> : (
            <Table>
              <thead><tr><Th>Segment</Th><Th className="hidden lg:table-cell">Rules</Th><Th className="text-right">Prospects</Th><Th className="text-right">Contacted</Th><Th className="text-right">Reply rate</Th><Th className="text-right">Signups</Th><Th /></tr></thead>
              <tbody>{rows.map((s) => (
                <Tr key={s.id}>
                  <Td><Link href={`/prospects?f=${encodeJson(s.rules)}`} className="font-medium hover:underline">{s.name}</Link>{s.natural_language ? <div className="text-[11.5px] text-fg-3">“{s.natural_language}”</div> : null}</Td>
                  <Td className="hidden max-w-[360px] text-[12px] text-fg-2 lg:table-cell">{describeFilter(s.rules)}</Td>
                  <Td className="text-right tabular">{fmtNum(s.n)}</Td>
                  <Td className="text-right tabular">{fmtNum(s.contacted)}</Td>
                  <Td className="text-right tabular">{fmtPct(s.replied, s.contacted)}</Td>
                  <Td className="text-right tabular">{fmtNum(s.signed)}</Td>
                  <Td><ActionButton size="xs" variant="ghost" action={deleteSegmentAction.bind(null, s.id)} confirm={{ title: "Delete segment?", description: s.name }}>Delete</ActionButton></Td>
                </Tr>
              ))}</tbody>
            </Table>
          )}
        </Panel>
      </div>
    </>
  );
}
