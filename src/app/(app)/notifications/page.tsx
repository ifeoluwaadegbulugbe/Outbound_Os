import Link from "next/link";
import { Bell } from "lucide-react";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { PageHeader, Panel, EmptyState } from "@/components/ui/display";
import { ActionButton } from "@/components/ui/dialog";
import { markNotificationsReadAction } from "../shell-actions";
import { cn, timeAgo } from "@/lib/utils";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const user = await requireUser();
  const rows = await asUser(user, (q) => q.many<{ id: string; type: string; title: string; body: string | null; link: string | null; read_at: Date | null; created_at: Date }>(sql`
    select id, type, title, body, link, read_at, created_at from notifications where user_id is null or user_id = ${user.userId} order by created_at desc limit 100`));
  const unread = rows.filter((r) => !r.read_at).length;
  return (
    <>
      <PageHeader title="Notifications" description="Replies, interested prospects, signups, finished jobs and milestones."
        actions={unread ? <ActionButton size="sm" action={markNotificationsReadAction}>Mark all read</ActionButton> : null} />
      <div className="p-4 md:p-6">
        <Panel padded={false}>
          {rows.length === 0 ? <EmptyState icon={<Bell />} title="You're all caught up" /> : (
            <ul className="divide-y divide-border">
              {rows.map((n) => {
                const inner = (
                  <div className="flex gap-3 px-4 py-3">
                    <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.read_at ? "bg-transparent" : "bg-accent")} aria-label={n.read_at ? undefined : "Unread"} />
                    <div className="min-w-0 flex-1">
                      <p className={cn("text-[13px]", !n.read_at && "font-medium")}>{n.title}</p>
                      {n.body ? <p className="text-[12px] text-fg-3">{n.body}</p> : null}
                    </div>
                    <span className="shrink-0 text-[11.5px] text-fg-3">{timeAgo(n.created_at)}</span>
                  </div>
                );
                return <li key={n.id}>{n.link ? <Link href={n.link} className="block hover:bg-surface-2">{inner}</Link> : inner}</li>;
              })}
            </ul>
          )}
        </Panel>
      </div>
    </>
  );
}
