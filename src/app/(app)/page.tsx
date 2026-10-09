import Link from "next/link";
import { ArrowRight, CalendarClock, Inbox, Send, Sparkles, Target, Flame, Plus } from "lucide-react";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { funnel, goalProgress, dailyBrief, type GoalRow, type GoalProgress } from "@/server/services/metrics";
import { computeInsights } from "@/server/services/insights";
import { PageHeader, Panel, EmptyState, Badge, Progress } from "@/components/ui/display";
import { LinkButton } from "@/components/ui/button";
import { FunnelChart } from "@/components/funnel";
import { fmtNum, timeAgo, fmtDate, cn } from "@/lib/utils";
import { categoryLabel } from "@/server/domain/taxonomy";
import { describeEvent } from "@/components/timeline";
import { emailFunnel, emailStats, senderUsage, EMAIL_FUNNEL } from "@/server/services/email-metrics";
import { EmailKpis } from "@/components/email-kpis";
import { Mail, AlertTriangle } from "lucide-react";

export const metadata = { title: "Overview" };

export default async function OverviewPage() {
  const user = await requireUser();
  const data = await asUser(user, async (q) => {
    const campaigns = await q.many<{ id: string; name: string; status: string; prospect_goal: number | null; end_date: string | null }>(sql`
      select id, name, status, prospect_goal, end_date from campaigns where status in ('active','paused','draft') order by (status = 'active') desc, created_at desc limit 3`);
    const focus = campaigns[0] ?? null;
    const [all, focusFunnel, brief] = await Promise.all([funnel(q), focus ? funnel(q, { campaignId: focus.id }) : null, dailyBrief(q)]);
    const goals = await q.many<GoalRow>(sql`select id, name, metric, target, start_date, end_date, campaign_id, geography from goals where end_date >= current_date - 7 order by end_date limit 4`);
    const progress: [GoalRow, GoalProgress][] = [];
    for (const g of goals) progress.push([g, await goalProgress(q, g)]);
    const events = await q.many<{ id: number; type: string; data: Record<string, unknown>; created_at: Date; prospect_id: string | null; business_name: string | null; channel: string | null }>(sql`
      select e.id, e.type, e.data, e.created_at, e.prospect_id, p.business_name, e.channel
      from outreach_events e left join prospects p on p.id = e.prospect_id
      where e.type not in ('prospect.discovered', 'message.generated')
      order by e.created_at desc limit 12`);
    const insights = await computeInsights(q, { limit: 3 });
    const [ef, es, senders] = await Promise.all([emailFunnel(q), emailStats(q), senderUsage(q)]);
    const paused = await q.value<boolean>(sql`select outreach_paused from workspaces where id = current_setting('app.workspace_id')::uuid`);
    return { campaigns, focus, all, focusFunnel, brief, progress, events, insights, ef, es, senders, paused };
  });

  const { all, focus, focusFunnel, brief } = data;
  const isEmpty = all.discovered === 0 && data.campaigns.length === 0;

  return (
    <>
      <PageHeader
        title={`Good ${greeting()}, ${user.name.split(" ")[0]}`}
        description="How the outbound engine is performing, and what needs you today."
        actions={<LinkButton href="/campaigns/new" variant="primary" size="sm"><Plus /> New campaign</LinkButton>}
      />
      <div className="space-y-4 p-4 md:p-6">
        {isEmpty ? (
          <Panel>
            <EmptyState
              icon={<Target />}
              title="No campaigns yet"
              description={`Create your first campaign and tell the system who you're looking for. It'll find and score prospects for ${user.productName}.`}
              action={<LinkButton href="/campaigns/new" variant="primary"><Plus /> Create campaign</LinkButton>}
            />
          </Panel>
        ) : null}

        <EmailAlerts senders={data.senders} paused={data.paused} />

        {/* Today's brief */}
        <section aria-label="Today's brief" className="grid grid-cols-2 gap-2 md:grid-cols-5">
          <BriefTile href="/outreach" icon={<Send />} label="Emails to review" value={data.es.awaitingReview} hint={`${fmtNum(data.es.queued)} queued to send`} accent={data.es.awaitingReview > 0} />
          <BriefTile href="/outreach?tab=sent" icon={<Mail />} label="Sent today" value={data.es.sentToday}
            hint={`of ${fmtNum(data.senders.filter((a) => a.status === "active" && a.provider !== "test_sink").reduce((n, a) => n + a.cap, 0))} daily capacity`} />
          <BriefTile href="/follow-ups" icon={<CalendarClock />} label="Follow-ups due" value={brief.followupsDue} hint="today" />
          <BriefTile href="/inbox?f=needs_response" icon={<Inbox />} label="Replies waiting" value={brief.repliesNeedingResponse} hint="need a response" accent={brief.repliesNeedingResponse > 0} />
          <BriefTile href="/prospects?status=INTERESTED" icon={<Flame />} label="Hot prospects" value={brief.hotProspects} hint="interested, not signed up" />
        </section>

        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <Panel title="Email funnel" description="All time · from real sends, replies and Orbit conversions. Test sends excluded."
            actions={<LinkButton href="/analytics" size="xs" variant="ghost">Analytics <ArrowRight /></LinkButton>}>
            <FunnelChart data={data.ef} stages={EMAIL_FUNNEL} successFrom={9} accentFrom={5} hrefFor={(s) => emailStageHref(s)} />
          </Panel>
          <EmailKpis es={data.es} />
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <Panel
            title={focus ? focus.name : "All prospects"}
            description={focus ? `${focus.status === "active" ? "Active campaign" : focus.status}${focus.prospect_goal ? ` · goal ${fmtNum(focus.prospect_goal)} prospects` : ""}` : "Across every campaign"}
            actions={focus ? <LinkButton href={`/campaigns/${focus.id}`} size="xs" variant="ghost">Open <ArrowRight /></LinkButton> : null}
          >
            <FunnelChart data={focusFunnel ?? all} hrefFor={(s) => `/prospects?stage=${s}${focus ? `&campaign=${focus.id}` : ""}`} />
            <p className="mt-3 border-t border-border pt-3 text-[12px] text-fg-3">
              North star: <span className="font-medium text-fg-2">qualified → activated</span>{" "}
              {(() => {
                const f = focusFunnel ?? all;
                return f.qualified ? <>— {fmtNum(f.activated)} of {fmtNum(f.qualified)} ({((f.activated / f.qualified) * 100).toFixed(1)}%)</> : "— no qualified prospects yet";
              })()}
            </p>
          </Panel>

          <div className="space-y-4">
            <Panel title="Goals" actions={<LinkButton href="/settings/goals" size="xs" variant="ghost">Manage</LinkButton>}>
              {data.progress.length === 0 ? (
                <p className="text-[12.5px] text-fg-3">
                  No goals yet. <Link href="/settings/goals" className="text-fg underline underline-offset-2">Set one</Link>, e.g. &ldquo;30,000 qualified prospects by 31 Oct&rdquo;.
                </p>
              ) : (
                <ul className="space-y-4">
                  {data.progress.map(([g, p]) => <GoalItem key={g.id} goal={g} p={p} />)}
                </ul>
              )}
            </Panel>

            <Panel title="Recommendation">
              {brief.bestSegment ? (
                <p className="text-[13px] text-fg-2">
                  Focus today&apos;s outreach on <span className="font-medium text-fg">{brief.bestSegment.label.replace(/ · (\w+)/, (_, c) => ` · ${categoryLabel(c)}`)}</span>. It has your best signup rate:{" "}
                  {(brief.bestSegment.signupRate * 100).toFixed(1)}% of {fmtNum(brief.bestSegment.contacted)} contacted.
                </p>
              ) : (
                <p className="text-[12.5px] text-fg-3">Recommendations appear once a segment has 20+ contacted prospects and at least one signup. Until then, work the highest-priority prospects first.</p>
              )}
              <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3 text-[12px]">
                <Yesterday label="Contacted yesterday" value={brief.yesterday.contacted} />
                <Yesterday label="Replies" value={brief.yesterday.replies} />
                <Yesterday label="Signups" value={brief.yesterday.signups} />
              </div>
            </Panel>
          </div>
        </div>

        <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
          <Panel title="Insights" description="Calculated from your data — never estimated" actions={<LinkButton href="/analytics" size="xs" variant="ghost">Analytics <ArrowRight /></LinkButton>}>
            {data.insights.length === 0 ? (
              <p className="text-[12.5px] text-fg-3">Not enough data yet. Insights need at least 30 contacted prospects per group being compared.</p>
            ) : (
              <ul className="space-y-2.5">
                {data.insights.map((i) => (
                  <li key={i.id} className="flex gap-2.5 text-[13px]">
                    <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
                    <div>
                      <p className="text-fg">{i.headline}</p>
                      <p className="text-[11.5px] text-fg-3">{i.evidence}</p>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Recent activity" padded={false}>
            {data.events.length === 0 ? (
              <p className="p-4 text-[12.5px] text-fg-3">Activity from outreach, replies and signups shows up here.</p>
            ) : (
              <ul className="divide-y divide-border">
                {data.events.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 px-4 py-2 text-[12.5px]">
                    <span className="min-w-0 flex-1 truncate">
                      {e.prospect_id ? <Link href={`/prospects/${e.prospect_id}`} className="font-medium hover:underline">{e.business_name}</Link> : null}{" "}
                      <span className="text-fg-2">{describeEvent(e.type, e.data, e.channel)}</span>
                    </span>
                    <span className="shrink-0 text-[11.5px] text-fg-3">{timeAgo(e.created_at)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}

function emailStageHref(stage: string): string {
  const map: Record<string, string> = {
    discovered: "/prospects", email_found: "/prospects?email=found", verified: "/prospects?email=verified", qualified: "/prospects?email=found&stage=qualified",
    drafted: "/outreach", sent: "/outreach?tab=sent", delivered: "/outreach?tab=sent", replied: "/inbox", interested: "/prospects?stage=interested",
    signed_up: "/prospects?stage=signed_up", activated: "/prospects?stage=activated", paid: "/prospects?stage=paid",
  };
  return map[stage] ?? "/prospects";
}

function EmailAlerts({ senders, paused }: { senders: { id: string; email_address: string | null; label: string; status: string; paused_reason: string | null; provider: string }[]; paused: boolean }) {
  const problems = senders.filter((a) => a.status !== "active" && a.paused_reason !== "Daily limit reached (provider)");
  const noSender = senders.filter((a) => a.provider !== "test_sink").length === 0;
  if (!paused && !problems.length && !noSender) return null;
  return (
    <div className="space-y-2">
      {paused ? <Alert href="/settings">All outreach is paused. Use Resume outreach in the top bar.</Alert> : null}
      {noSender ? <Alert href="/integrations#sending" tone="info">Connect a Gmail or Outlook mailbox to start sending email.</Alert> : null}
      {problems.map((a) => (
        <Alert key={a.id} href="/integrations#sending">
          {a.email_address ?? a.label}: {a.status === "needs_reconnect" ? "needs to be reconnected" : a.paused_reason ?? a.status}
        </Alert>
      ))}
    </div>
  );
}

function Alert({ href, children, tone = "warning" }: { href: string; children: React.ReactNode; tone?: "warning" | "info" }) {
  return (
    <Link href={href} className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-[12.5px]", tone === "warning" ? "border-warning/30 bg-warning-subtle text-warning" : "border-border bg-surface text-fg-2")}>
      <AlertTriangle className="size-3.5 shrink-0" /> <span className="flex-1">{children}</span> <ArrowRight className="size-3.5" />
    </Link>
  );
}

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "morning" : h < 17 ? "afternoon" : "evening";
}

function BriefTile({ href, icon, label, value, hint, accent }: { href: string; icon: React.ReactNode; label: string; value: number; hint: string; accent?: boolean }) {
  return (
    <Link href={href} className={cn("group rounded-lg border bg-surface p-3 shadow-sm transition-colors hover:border-border-strong", accent ? "border-accent/40" : "border-border")}>
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-fg-3 [&_svg]:size-3.5">
        <span className={accent ? "text-accent" : undefined}>{icon}</span>
        {label}
      </div>
      <div className="mt-1.5 text-[22px] font-semibold tabular tracking-tight">{fmtNum(value)}</div>
      <div className="text-[11.5px] text-fg-3">{hint}</div>
    </Link>
  );
}

function Yesterday({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <div className="text-[15px] font-semibold tabular">{fmtNum(value)}</div>
      <div className="text-fg-3">{label}</div>
    </div>
  );
}

const GOAL_STATUS: Record<GoalProgress["status"], { label: string; tone: "success" | "info" | "warning" | "neutral" | "danger" }> = {
  ahead: { label: "Ahead of target", tone: "success" },
  on_track: { label: "On track", tone: "info" },
  behind: { label: "Behind target", tone: "warning" },
  not_started: { label: "Not started", tone: "neutral" },
  completed: { label: "Completed", tone: "success" },
  ended: { label: "Ended", tone: "neutral" },
};

function GoalItem({ goal, p }: { goal: GoalRow; p: GoalProgress }) {
  const st = GOAL_STATUS[p.status];
  return (
    <li>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-[13px] font-medium">{goal.name}</p>
          <p className="text-[11.5px] text-fg-3">by {fmtDate(goal.end_date)} · {p.daysRemaining} days left</p>
        </div>
        <Badge tone={st.tone}>{st.label}</Badge>
      </div>
      <div className="mt-2 flex items-baseline justify-between text-[12px] tabular">
        <span><span className="text-[15px] font-semibold">{fmtNum(p.completed)}</span> <span className="text-fg-3">/ {fmtNum(goal.target)}</span></span>
        <span className="text-fg-3">{p.pct.toFixed(1)}%</span>
      </div>
      <Progress value={p.pct} tone={st.tone === "warning" ? "warning" : st.tone === "success" ? "success" : "accent"} className="mt-1" />
      <div className="mt-1.5 flex justify-between text-[11.5px] text-fg-3 tabular">
        <span>Pace {fmtNum(Math.round(p.currentPace))}/day</span>
        <span>Need {fmtNum(Math.ceil(p.requiredPace))}/day</span>
        <span>Projected {fmtNum(p.projected)}</span>
      </div>
    </li>
  );
}
