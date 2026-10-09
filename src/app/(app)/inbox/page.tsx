import Link from "next/link";
import { Inbox as InboxIcon } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { PageHeader, Panel, EmptyState, ScoreBadge } from "@/components/ui/display";
import { IntentBadge, ChannelLabel, StatusBadge } from "@/components/ui/status";
import { categoryLabel } from "@/server/domain/taxonomy";
import { cn, timeAgo } from "@/lib/utils";
import { Thread } from "./thread";

export const metadata = { title: "Inbox" };

const FILTERS = [
  { key: "all", label: "All" },
  { key: "needs_response", label: "Needs response" },
  { key: "interested", label: "Interested" },
  { key: "pricing", label: "Pricing" },
  { key: "follow_up", label: "Follow-up" },
  { key: "signup", label: "New signup" },
  { key: "high", label: "High priority" },
];

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ f?: string; c?: string; p?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const f = FILTERS.some((x) => x.key === sp.f) ? sp.f! : "all";
  const where = {
    all: sql`true`,
    needs_response: sql`c.status = 'needs_response'`,
    interested: sql`c.intent in ('interested','demo_request','signup_intent')`,
    pricing: sql`c.intent = 'pricing'`,
    follow_up: sql`c.intent = 'maybe_later' or p.status = 'FOLLOW_UP'`,
    signup: sql`p.signed_up and p.signup_at > now() - interval '14 days'`,
    high: sql`c.priority = 'high' and c.status <> 'closed'`,
  }[f as "all"];

  const data = await asUser(user, async (q) => {
    const list = await q.many<{ id: string; prospect_id: string; channel: string; status: string; intent: string | null; priority: string; unread: boolean; last_message_at: Date | null; business_name: string; icp_score: number | null; last_body: string | null; last_direction: string | null }>(sql`
      select c.id, c.prospect_id, c.channel, c.status, c.intent, c.priority, c.unread, c.last_message_at, p.business_name, p.icp_score,
        (select body from conversation_messages m where m.conversation_id = c.id order by occurred_at desc limit 1) as last_body,
        (select direction from conversation_messages m where m.conversation_id = c.id order by occurred_at desc limit 1) as last_direction
      from conversations c join prospects p on p.id = c.prospect_id
      where exists (select 1 from conversation_messages m where m.conversation_id = c.id and m.direction = 'inbound') and (${where})
        ${sp.p ? sql`and c.prospect_id = ${sp.p}` : sql``}
      order by (c.status = 'needs_response') desc, c.last_message_at desc nulls last limit 100`);
    const selectedId = sp.c ?? list[0]?.id ?? null;
    const selected = selectedId ? await q.maybe<{ id: string; prospect_id: string; channel: string; status: string; intent: string | null; intent_confidence: number | null; summary: string | null; next_action: string | null; campaign_name: string | null;
      business_name: string; category: string | null; city: string | null; icp_score: number | null; p_status: string; instagram_handle: string | null; tiktok_handle: string | null; whatsapp: string | null; phone: string | null; email: string | null; is_demo: boolean; do_not_contact: boolean }>(sql`
      select c.id, c.prospect_id, c.channel, c.status, c.intent, c.intent_confidence, c.summary, c.next_action, cmp.name as campaign_name,
        p.business_name, p.category, p.city, p.icp_score, p.status as p_status, p.instagram_handle, p.tiktok_handle, p.whatsapp, p.phone, p.email, p.is_demo, p.do_not_contact
      from conversations c join prospects p on p.id = c.prospect_id left join campaigns cmp on cmp.id = c.campaign_id where c.id = ${selectedId}`) : null;
    const messages = selected ? await q.many<{ id: string; direction: "inbound" | "outbound"; body: string; occurred_at: Date; classification: { intent?: string; confidence?: number } | null }>(sql`
      select id, direction, body, occurred_at, classification from conversation_messages where conversation_id = ${selected.id} order by occurred_at`) : [];
    if (selected) await q.exec(sql`update conversations set unread = false where id = ${selected.id}`);
    const counts = await q.one<{ needs: number }>(sql`select count(*)::int as needs from conversations where status = 'needs_response'`);
    return { list, selected, messages, counts };
  });

  return (
    <>
      <PageHeader title="Inbox" description={`${data.counts.needs} conversation${data.counts.needs === 1 ? "" : "s"} need a response. Paste replies from Instagram, TikTok or WhatsApp — they're classified automatically.`}>
        <nav className="-mb-3 flex gap-1 overflow-x-auto" aria-label="Inbox filters">
          {FILTERS.map((x) => (
            <Link key={x.key} href={`/inbox${x.key === "all" ? "" : `?f=${x.key}`}`} className={cn("whitespace-nowrap border-b-2 px-2 pb-2 text-[12.5px]", f === x.key ? "border-fg font-medium text-fg" : "border-transparent text-fg-3 hover:text-fg")}>{x.label}</Link>
          ))}
        </nav>
      </PageHeader>
      <div className="p-4 md:p-6">
        {data.list.length === 0 ? (
          <Panel><EmptyState icon={<InboxIcon />} title="No conversations here" description="When a prospect replies, log it from the prospect page (or the browser extension) and it appears here with an AI summary and suggested response." /></Panel>
        ) : (
          <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
            <Panel padded={false} className="lg:max-h-[calc(100dvh-180px)] lg:overflow-y-auto">
              <ul className="divide-y divide-border">
                {data.list.map((c) => (
                  <li key={c.id}>
                    <Link href={`/inbox?${new URLSearchParams({ ...(f !== "all" ? { f } : {}), c: c.id })}`} className={cn("block px-4 py-3 hover:bg-surface-2", data.selected?.id === c.id && "bg-surface-2")}>
                      <div className="flex items-center gap-2">
                        {c.unread ? <span className="size-2 shrink-0 rounded-full bg-accent" aria-label="Unread" /> : null}
                        <span className={cn("min-w-0 flex-1 truncate text-[13px]", c.unread ? "font-semibold" : "font-medium")}>{c.business_name}</span>
                        <span className="shrink-0 text-[11px] text-fg-3">{timeAgo(c.last_message_at)}</span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-fg-3">{c.last_direction === "outbound" ? "You: " : ""}{c.last_body}</p>
                      <div className="mt-1.5 flex items-center gap-1.5"><IntentBadge intent={c.intent} /><ChannelLabel channel={c.channel} />{c.status === "needs_response" ? <span className="text-[11px] font-medium text-accent">Needs reply</span> : null}</div>
                    </Link>
                  </li>
                ))}
              </ul>
            </Panel>
            {data.selected ? (
              <Panel padded={false}>
                <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
                  <Link href={`/prospects/${data.selected.prospect_id}`} className="text-[15px] font-semibold hover:underline">{data.selected.business_name}</Link>
                  <ScoreBadge score={data.selected.icp_score} />
                  <StatusBadge status={data.selected.p_status} />
                  <span className="text-[12px] text-fg-3">{categoryLabel(data.selected.category)}{data.selected.city ? ` · ${data.selected.city}` : ""}{data.selected.campaign_name ? ` · ${data.selected.campaign_name}` : ""}</span>
                </header>
                <Thread conversation={data.selected} messages={data.messages} canEdit={can(user, "member")} />
              </Panel>
            ) : null}
          </div>
        )}
      </div>
    </>
  );
}
