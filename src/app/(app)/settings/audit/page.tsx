import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { Panel } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { fmtDateTime } from "@/lib/utils";

export const metadata = { title: "Audit log" };

export default async function AuditSettings() {
  const user = await requireUser("admin");
  const rows = await asUser(user, (q) => q.many<{ id: number; actor_type: string; name: string | null; action: string; entity_type: string | null; entity_id: string | null; data: unknown; created_at: Date }>(sql`
    select a.id, a.actor_type, u.name, a.action, a.entity_type, a.entity_id, a.data, a.created_at
    from audit_logs a left join users u on u.id = a.actor_id order by a.created_at desc limit 300`));
  return (
    <Panel title="Audit log" description="Every important action: who, what, when." padded={false}>
      <Table>
        <thead><tr><Th>When</Th><Th>Who</Th><Th>Action</Th><Th className="hidden md:table-cell">Details</Th></tr></thead>
        <tbody>{rows.map((r) => (
          <Tr key={r.id}>
            <Td className="whitespace-nowrap text-[12px] tabular text-fg-3">{fmtDateTime(r.created_at)}</Td>
            <Td className="text-[12px]">{r.name ?? (r.actor_type === "webhook" ? "Orbit webhook" : r.actor_type === "ai" ? "AI" : "System")}</Td>
            <Td className="text-[12px] font-medium">{r.action.replace(/[._]/g, " ")}</Td>
            <Td className="hidden max-w-[420px] truncate font-mono text-[11px] text-fg-3 md:table-cell">{r.data ? JSON.stringify(r.data) : r.entity_type ? `${r.entity_type} ${r.entity_id ?? ""}` : ""}</Td>
          </Tr>
        ))}</tbody>
      </Table>
    </Panel>
  );
}
