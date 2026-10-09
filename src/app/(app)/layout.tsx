import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { Sidebar, type NavCounts } from "@/components/shell/sidebar";
import { TopBar } from "@/components/shell/topbar";
import { Shortcuts } from "@/components/shell/shortcuts";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const data = await asUser(user, async (q) => {
    const counts = await q.one<NavCounts>(sql`
      select
        (select count(*)::int from outreach_messages where status = 'needs_review') as review,
        (select count(*)::int from outreach_messages where status = 'approved') as approved,
        (select count(*)::int from conversations where status = 'needs_response') as inbox,
        (select count(*)::int from followups where status = 'pending' and due_at < (current_date + 1)) as followups,
        (select count(*)::int from possible_duplicates where status = 'pending') as duplicates,
        (select count(*)::int from notifications where read_at is null and (user_id is null or user_id = ${user.userId})) as notifications`);
    const ws = await q.one<{ outreach_paused: boolean }>(sql`select outreach_paused from workspaces where id = ${user.workspaceId}`);
    return { counts, paused: ws.outreach_paused };
  });

  return (
    <div className="flex min-h-dvh">
      <Sidebar counts={data.counts} user={{ name: user.name, email: user.email, role: user.role }} workspace={user.workspaceName} />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar paused={data.paused} canPause={user.role !== "viewer"} notifications={data.counts.notifications} counts={data.counts}
          user={{ name: user.name, email: user.email, role: user.role }} workspace={user.workspaceName} />
        <main className="min-w-0 flex-1">{children}</main>
      </div>
      <Shortcuts />
    </div>
  );
}
