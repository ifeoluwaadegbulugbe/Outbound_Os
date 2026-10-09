import Link from "next/link";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { Panel, Badge } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { timeAgo, fmtNum } from "@/lib/utils";
import { DncForm } from "../forms";

export const metadata = { title: "Do-not-contact list" };

export default async function DncSettings() {
  const user = await requireUser();
  const data = await asUser(user, async (q) => ({
    rows: await q.many<{ id: string; kind: string; value: string; reason: string; note: string | null; prospect_id: string | null; created_at: Date }>(sql`
      select id, kind, value, reason, note, prospect_id, created_at from dnc_entries where kind <> 'prospect' order by created_at desc limit 200`),
    total: await q.value<number>(sql`select count(distinct coalesce(prospect_id::text, value))::int from dnc_entries`),
  }));
  return (
    <>
      <DncForm />
      <Panel title={`Suppression list · ${fmtNum(data.total)} businesses`} padded={false} description="Opt-outs are added automatically when a reply asks to stop. Entries survive re-discovery and re-import.">
        {data.rows.length === 0 ? <p className="p-4 text-[12.5px] text-fg-3">Empty.</p> : (
          <Table>
            <thead><tr><Th>Identifier</Th><Th>Reason</Th><Th className="hidden md:table-cell">Note</Th><Th>Added</Th></tr></thead>
            <tbody>{data.rows.map((r) => (
              <Tr key={r.id}>
                <Td><span className="text-fg-3">{r.kind}</span> {r.prospect_id ? <Link className="hover:underline" href={`/prospects/${r.prospect_id}`}>{r.value}</Link> : r.value}</Td>
                <Td><Badge tone={r.reason === "opt_out" ? "danger" : "neutral"}>{r.reason.replace("_", " ")}</Badge></Td>
                <Td className="hidden max-w-[320px] truncate text-[12px] text-fg-3 md:table-cell">{r.note}</Td>
                <Td className="text-[12px] text-fg-3">{timeAgo(r.created_at)}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        )}
      </Panel>
    </>
  );
}
