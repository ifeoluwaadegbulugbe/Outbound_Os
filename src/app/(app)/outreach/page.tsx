import Link from "next/link";
import { Send, CheckCheck, Inbox as InboxIcon } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { senderUsage } from "@/server/services/outreach";
import { PageHeader, Panel, EmptyState, Progress } from "@/components/ui/display";
import { LinkButton } from "@/components/ui/button";
import { cn, fmtNum, timeAgo } from "@/lib/utils";
import { ReviewList, type ReviewItem } from "./review-list";
import { SendSession, type SendItem } from "./send-session";
import { JobProgress } from "@/components/job-progress";
import { MessageStatusBadge, ChannelLabel } from "@/components/ui/status";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { CHANNEL_LABELS, type Channel } from "@/server/domain/taxonomy";
import { senderUsage as emailSenderUsage } from "@/server/services/email-metrics";
import { EmailReadyList, EmailQueuedList, EmailSentList, type EmailRow } from "./email-lists";

export const metadata = { title: "Send Queue" };

const EMAIL_SELECT = sql`
  m.id, m.prospect_id, p.business_name, p.email, p.email_status, p.city, m.subject, m.kind, m.step, c.name as campaign_name, m.status, m.error,
  m.queued_at, m.sent_at, m.to_email, m.delivery_status, a.email_address as sender`;

const ITEM_SELECT = sql`
  m.id, m.prospect_id, m.campaign_id, m.channel, m.kind, m.step, m.angle, m.subject, m.body, m.status, m.validation, m.generator, m.edited, m.created_at,
  m.scheduled_for, p.business_name, p.first_name, p.owner_name, p.category, p.city, p.icp_score, p.priority_score, p.instagram_handle, p.tiktok_handle,
  p.whatsapp, p.phone, p.email, p.is_demo, p.bio, c.name as campaign_name`;

export default async function OutreachPage({ searchParams }: { searchParams: Promise<{ tab?: string; batch?: string; channel?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const TABS = ["review", "ready", "queued", "sent", "social"] as const;
  type Tab = (typeof TABS)[number];
  const tab: Tab = sp.tab === "send" ? "social" : (TABS as readonly string[]).includes(sp.tab ?? "") ? (sp.tab as Tab) : "review";

  const data = await asUser(user, async (q) => {
    const channelFilter = sp.channel ? sql`and m.channel = ${sp.channel}` : sql``;
    const batchFilter = sp.batch ? sql`and m.batch_id = ${sp.batch}` : sql``;
    const counts = await q.one<{ review: number; blocked: number; send: number; sent_today: number; ready: number; queued: number }>(sql`
      select count(*) filter (where status = 'needs_review')::int as review, count(*) filter (where status = 'blocked')::int as blocked,
             count(*) filter (where channel <> 'email' and (status = 'approved' or (status = 'scheduled' and scheduled_for <= now())))::int as send,
             count(*) filter (where channel = 'email' and status = 'approved' and not is_test)::int as ready,
             count(*) filter (where channel = 'email' and status in ('queued','sending'))::int as queued,
             count(*) filter (where status = 'sent' and sent_at >= date_trunc('day', now()))::int as sent_today
      from outreach_messages`);
    const batches = await q.many<{ id: string; total: number; generated: number; blocked: number; status: string; created_at: Date; job_id: string | null }>(sql`
      select id, total, generated, blocked, status, created_at, job_id from outreach_batches where status in ('queued','generating') or created_at > now() - interval '2 hours' order by created_at desc limit 3`);
    const usage = (await senderUsage(q)).filter((u) => u.channel !== "email");
    const emailAccounts = await emailSenderUsage(q);
    let emailRows: EmailRow[] = [];
    let sentEmails: (EmailRow & { replied: boolean })[] = [];
    let review: ReviewItem[] = [];
    let send: SendItem[] = [];
    let sent: (ReviewItem & { sent_at: Date })[] = [];
    if (tab === "review") {
      review = await q.many<ReviewItem>(sql`
        select ${ITEM_SELECT} from outreach_messages m join prospects p on p.id = m.prospect_id left join campaigns c on c.id = m.campaign_id
        where m.status in ('needs_review','blocked') ${channelFilter} ${batchFilter}
        order by (m.status = 'blocked'), p.is_demo, p.priority_score desc nulls last, m.created_at limit 100`);
    } else if (tab === "ready" || tab === "queued") {
      emailRows = await q.many<EmailRow>(sql`
        select ${EMAIL_SELECT} from outreach_messages m join prospects p on p.id = m.prospect_id left join campaigns c on c.id = m.campaign_id
          left join sender_accounts a on a.id = m.sender_account_id
        where m.channel = 'email' and not m.is_test and ${tab === "ready" ? sql`m.status = 'approved'` : sql`m.status in ('queued','sending')`}
        order by m.kind = 'followup' desc, ${tab === "ready" ? sql`p.priority_score desc nulls last, m.approved_at` : sql`m.queued_at`} limit 300`);
    } else if (tab === "sent") {
      if (!sp.channel || sp.channel === "email") sentEmails = await q.many(sql`
        select ${EMAIL_SELECT}, exists(select 1 from email_events e where e.message_id = m.id and e.type = 'replied' and coalesce(e.detail,'') not like 'Auto-reply%') as replied
        from outreach_messages m join prospects p on p.id = m.prospect_id left join campaigns c on c.id = m.campaign_id
          left join sender_accounts a on a.id = m.sender_account_id
        where m.channel = 'email' and m.status = 'sent' and not m.is_test order by m.sent_at desc limit 200`);
      if (sp.channel !== "email") sent = await q.many(sql`
        select ${ITEM_SELECT}, m.sent_at from outreach_messages m join prospects p on p.id = m.prospect_id left join campaigns c on c.id = m.campaign_id
        where m.status = 'sent' and m.channel <> 'email' ${channelFilter} order by m.sent_at desc limit 100`);
    } else if (tab === "social") {
      send = await q.many<SendItem>(sql`
        select ${ITEM_SELECT} from outreach_messages m join prospects p on p.id = m.prospect_id left join campaigns c on c.id = m.campaign_id
        where m.channel <> 'email' and (m.status = 'approved' or (m.status = 'scheduled' and m.scheduled_for <= now())) ${channelFilter}
        order by m.kind = 'followup' desc, p.priority_score desc nulls last, m.approved_at limit 200`);
    }
    const paused = await q.value<boolean>(sql`select outreach_paused from workspaces where id = ${user.workspaceId}`);
    return { counts, batches, usage, review, send, sent, emailAccounts, emailRows, sentEmails, paused };
  });

  const tabs = [
    { key: "review", label: "Review", count: data.counts.review + data.counts.blocked },
    { key: "ready", label: "Ready to send", count: data.counts.ready },
    { key: "queued", label: "Queued", count: data.counts.queued },
    { key: "sent", label: "Sent", count: null },
    { key: "social", label: "Social DMs", count: data.counts.send },
  ];
  const activeEmail = data.emailAccounts.filter((a) => a.status === "active");
  const capLeft = activeEmail.reduce((n, a) => n + Math.max(0, a.cap - a.sent_today), 0);
  const nextNote = data.paused ? "all outreach is paused" : !activeEmail.length ? "no active sending account" : `${fmtNum(capLeft)} more can go out today · Mon–Sat 08:00–19:00 (Lagos) unless the campaign sets a window`;

  return (
    <>
      <PageHeader
        title="Send Queue"
        description="Review drafts, then send emails one by one or queue them. Queued emails go out paced within each mailbox's limits. Social DMs are sent by you in each app."
        actions={<LinkButton href="/prospects?view=priority" size="sm"><Send /> Draft more messages</LinkButton>}
      >
        <nav className="-mb-3 flex gap-1 overflow-x-auto" aria-label="Send queue sections">
          {tabs.map((t) => (
            <Link key={t.key} href={`/outreach${t.key === "review" ? "" : `?tab=${t.key}`}`}
              className={cn("flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2 pb-2 text-[12.5px]", tab === t.key ? "border-fg font-medium text-fg" : "border-transparent text-fg-3 hover:text-fg")}>
              {t.label}
              {t.count ? <span className="rounded bg-surface-3 px-1.5 text-[11px] tabular leading-[18px] text-fg-2">{fmtNum(t.count)}</span> : null}
            </Link>
          ))}
        </nav>
      </PageHeader>

      <div className="space-y-4 p-4 md:p-6">
        {data.batches.filter((b) => b.status === "queued" || b.status === "generating").map((b) => (
          <Panel key={b.id}>
            <JobProgress jobId={b.job_id} title={`Generating ${fmtNum(b.total)} personalised messages`} doneHref={`/outreach?batch=${b.id}`} />
          </Panel>
        ))}

        {tab !== "social" ? (
          data.emailAccounts.length ? (
            <section aria-label="Email sending capacity" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              {data.emailAccounts.map((a) => (
                <Link key={a.id} href="/integrations#sending" className="rounded-lg border border-border bg-surface px-3 py-2.5 shadow-sm hover:border-border-strong">
                  <div className="flex items-baseline justify-between gap-2 text-[12px]">
                    <span className="truncate font-medium">{a.email_address ?? a.label}</span>
                    <span className="tabular text-fg-2">{a.sent_today}/{a.cap}</span>
                  </div>
                  <Progress value={a.sent_today} max={Math.max(1, a.cap)} tone={a.status !== "active" ? "danger" : a.sent_today >= a.cap ? "warning" : "success"} className="mt-1.5" />
                  {a.status !== "active" ? <p className="mt-1 truncate text-[11.5px] text-warning">{a.paused_reason ?? a.status}</p> : null}
                </Link>
              ))}
            </section>
          ) : (
            <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-fg-3">
              Connect Gmail or Outlook in <Link className="text-fg underline" href="/integrations#sending">Data Sources → Sending accounts</Link> to send email.
            </p>
          )
        ) : data.usage.length ? (
          <section aria-label="Daily sending capacity" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {data.usage.map((u) => (
              <div key={u.id} className="rounded-lg border border-border bg-surface px-3 py-2.5 shadow-sm">
                <div className="flex items-baseline justify-between gap-2 text-[12px]">
                  <span className="truncate font-medium">{CHANNEL_LABELS[u.channel as Channel] ?? u.channel} · <span className="text-fg-3">{u.label}</span></span>
                  <span className="tabular text-fg-2">{u.sentToday}/{u.cap}</span>
                </div>
                <Progress value={u.sentToday} max={u.cap} tone={u.sentToday >= u.cap ? "danger" : u.sentToday / u.cap > 0.8 ? "warning" : "success"} className="mt-1.5" />
              </div>
            ))}
          </section>
        ) : (
          <p className="rounded-lg border border-dashed border-border px-3 py-2 text-[12.5px] text-fg-3">
            Add your sending accounts in <Link className="text-fg underline" href="/settings/senders">Settings → Sender accounts</Link> to track daily caps and warm-up.
          </p>
        )}

        {tab === "review" ? (
          data.review.length ? (
            <ReviewList items={data.review} canEdit={can(user, "member")} batchId={sp.batch ?? null} totalReady={sp.batch || sp.channel ? undefined : data.counts.review} totalBlocked={sp.batch || sp.channel ? undefined : data.counts.blocked} />
          ) : (
            <Panel>
              <EmptyState icon={<CheckCheck />} title="Nothing to review" description="Select prospects and choose “Generate messages”, or wait for follow-ups to be drafted automatically."
                action={<LinkButton href="/prospects?view=priority" variant="primary" size="sm">Pick top prospects</LinkButton>} />
            </Panel>
          )
        ) : null}

        {tab === "ready" ? (
          <Panel padded={false}>
            {data.emailRows.length ? <EmailReadyList rows={data.emailRows} total={data.counts.ready} canEdit={can(user, "member")} /> : (
              <EmptyState icon={<Send />} title="No approved emails" description="Approve email drafts in Review (or open one in the composer) and they appear here." action={<LinkButton href="/outreach" size="sm">Go to Review</LinkButton>} />
            )}
          </Panel>
        ) : null}

        {tab === "queued" ? (
          <Panel padded={false}>
            {data.emailRows.length ? <EmailQueuedList rows={data.emailRows} total={data.counts.queued} canEdit={can(user, "member")} nextNote={nextNote} /> : (
              <EmptyState icon={<CheckCheck />} title="Nothing queued" description="Queue approved emails from Ready to send. The system sends them one at a time with gaps between sends." />
            )}
          </Panel>
        ) : null}

        {tab === "sent" && (!sp.channel || sp.channel === "email") ? (
          <Panel padded={false} title="Emails sent" description="Delivery shows “Accepted” when the provider took the message, “Delivered” once 48 hours pass with no bounce.">
            {data.sentEmails.length ? <EmailSentList rows={data.sentEmails} /> : <EmptyState icon={<InboxIcon />} title="No emails sent yet" />}
          </Panel>
        ) : null}

        {tab === "social" ? (
          data.send.length ? (
            <SendSession items={data.send} usage={data.usage} />
          ) : (
            <Panel>
              <EmptyState icon={<Send />} title="Your send queue is empty" description="Approve drafts in Review and they'll line up here, one per prospect, ready to open and send."
                action={<LinkButton href="/outreach" size="sm">Go to Review</LinkButton>} />
            </Panel>
          )
        ) : null}

        {tab === "sent" && sp.channel !== "email" ? (
          <Panel padded={false} title="Social DMs marked sent" actions={!sp.channel ? null : <Link href="/outreach?tab=sent" className="text-[12px] text-fg-3">Show emails</Link>}>
            {data.sent.length === 0 ? (
              <EmptyState icon={<InboxIcon />} title="No messages sent yet" />
            ) : (
              <Table>
                <thead>
                  <tr><Th>Prospect</Th><Th>Channel</Th><Th className="hidden md:table-cell">Message</Th><Th>Status</Th><Th>Sent</Th></tr>
                </thead>
                <tbody>
                  {data.sent.map((m) => (
                    <Tr key={m.id}>
                      <Td><Link href={`/prospects/${m.prospect_id}`} className="font-medium hover:underline">{m.business_name}</Link><div className="text-[11.5px] text-fg-3">{m.kind === "followup" ? `Follow-up ${m.step}` : "First message"}{m.campaign_name ? ` · ${m.campaign_name}` : ""}</div></Td>
                      <Td><ChannelLabel channel={m.channel} /></Td>
                      <Td className="hidden max-w-[420px] md:table-cell"><p className="truncate text-fg-2">{m.body}</p></Td>
                      <Td><MessageStatusBadge status={m.status} /></Td>
                      <Td className="whitespace-nowrap text-[12px] text-fg-3">{timeAgo(m.sent_at)}</Td>
                    </Tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Panel>
        ) : null}
      </div>
    </>
  );
}
