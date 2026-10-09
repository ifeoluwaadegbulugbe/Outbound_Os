import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { Panel } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { timeAgo } from "@/lib/utils";
import { AddMemberForm, MemberRole } from "../forms";

export const metadata = { title: "Team" };

export default async function TeamSettings() {
  const user = await requireUser();
  const members = await asUser(user, (q) => q.many<{ id: string; name: string; email: string; role: string; last_login_at: Date | null; sent_7d: number }>(sql`
    select u.id, u.name, u.email, m.role, u.last_login_at,
      (select count(*)::int from outreach_messages o where o.sent_by = u.id and o.sent_at > now() - interval '7 days') as sent_7d
    from workspace_members m join users u on u.id = m.user_id where m.workspace_id = ${user.workspaceId} order by m.created_at`));
  const admin = can(user, "admin");
  return (
    <>
      <Panel title="Team" padded={false}>
        <Table>
          <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Sent (7d)</Th><Th>Last sign-in</Th></tr></thead>
          <tbody>{members.map((m) => (
            <Tr key={m.id}>
              <Td className="font-medium">{m.name}{m.id === user.userId ? <span className="text-fg-3"> (you)</span> : null}</Td>
              <Td className="text-fg-2">{m.email}</Td>
              <Td>{admin ? <MemberRole userId={m.id} role={m.role} disabled={m.id === user.userId} /> : <span className="capitalize">{m.role}</span>}</Td>
              <Td className="tabular">{m.sent_7d}</Td>
              <Td className="text-[12px] text-fg-3">{timeAgo(m.last_login_at)}</Td>
            </Tr>
          ))}</tbody>
        </Table>
        <p className="border-t border-border px-4 py-2 text-[11.5px] text-fg-3">Owner: everything · Admin: settings, integrations, team · Member: discover, draft, approve, send · Viewer: read-only.</p>
      </Panel>
      {admin ? <AddMemberForm /> : null}
    </>
  );
}
