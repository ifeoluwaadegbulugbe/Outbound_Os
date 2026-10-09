import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, AtSign, Globe, Mail, Phone, Music2, Link2, MapPin, ExternalLink } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { Panel, Badge, ScoreBadge, Dl, Progress } from "@/components/ui/display";
import { StatusBadge, MessageStatusBadge, IntentBadge, ChannelLabel } from "@/components/ui/status";
import { categoryLabel } from "@/server/domain/taxonomy";
import { COMPONENT_LABELS, COMPONENT_MAX, type ScoreReason, type ScoreComponent } from "@/server/domain/scoring";
import { describeEvent } from "@/components/timeline";
import { cn, fmtCompact, fmtDate, fmtDateTime, timeAgo } from "@/lib/utils";
import { ProspectActions } from "./prospect-actions";
import { ResearchPanel } from "./research-panel";
import { NoteForm } from "./note-form";
import { profileUrl } from "@/server/domain/channels";

export const metadata = { title: "Prospect" };

export default async function ProspectPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await asUser(user, async (q) => {
    const p = await q.maybe<Record<string, unknown> & {
      id: string; business_name: string; status: string; merged_into: string | null; signals: Record<string, { value: unknown; source: string; quote?: string }>;
      score_reasons: { reasons: ScoreReason[]; components: Record<ScoreComponent, number>; completeness: { score: number; present: string[]; missing: string[] }; priority: { label: string; weight: number; value: number }[] } | null;
    }>(sql`select * from prospects where id = ${id}`);
    if (!p) return null;
    const [research, messages, events, followups, notes, campaigns, sources, conversations, duplicates, conversions, allCampaigns] = await Promise.all([
      q.maybe<{ id: string; summary: string; statements: { statements: { text: string; kind: string; basis: string[] }[]; facts: { id: string; text: string; source: string }[]; unknowns: string[] }; why_relevant: string[]; recommended_angle: string | null; value_props: string[]; confidence: number; generator: string; created_at: Date }>(
        sql`select id, summary, statements, why_relevant, recommended_angle, value_props, confidence, generator, created_at from prospect_research where prospect_id = ${id} order by created_at desc limit 1`),
      q.many<{ id: string; channel: string; kind: string; step: number; body: string; status: string; sent_at: Date | null; created_at: Date; generator: string }>(
        sql`select id, channel, kind, step, body, status, sent_at, created_at, generator from outreach_messages where prospect_id = ${id} and status <> 'rejected' order by created_at desc limit 20`),
      q.many<{ id: number; type: string; data: Record<string, unknown>; channel: string | null; created_at: Date; actor_type: string }>(
        sql`select id, type, data, channel, created_at, actor_type from outreach_events where prospect_id = ${id} order by created_at desc limit 60`),
      q.many<{ id: string; step: number; due_at: Date; status: string; channel: string | null; cancel_reason: string | null }>(
        sql`select id, step, due_at, status, channel, cancel_reason from followups where prospect_id = ${id} order by due_at`),
      q.many<{ id: string; body: string; created_at: Date; name: string | null }>(
        sql`select n.id, n.body, n.created_at, u.name from prospect_notes n left join users u on u.id = n.user_id where n.prospect_id = ${id} order by n.created_at desc`),
      q.many<{ id: string; name: string }>(sql`select c.id, c.name from campaign_prospects cp join campaigns c on c.id = cp.campaign_id where cp.prospect_id = ${id}`),
      q.many<{ source: string; source_url: string | null; discovered_at: Date }>(sql`select source, source_url, discovered_at from prospect_sources where prospect_id = ${id} order by discovered_at`),
      q.many<{ id: string; channel: string; intent: string | null; status: string; messages: { direction: string; body: string; occurred_at: Date }[] }>(sql`
        select c.id, c.channel, c.intent, c.status,
               coalesce((select json_agg(json_build_object('direction', m.direction, 'body', m.body, 'occurred_at', m.occurred_at) order by m.occurred_at)
                         from conversation_messages m where m.conversation_id = c.id), '[]'::json) as messages
        from conversations c where c.prospect_id = ${id} order by c.last_message_at desc nulls last`),
      q.many<{ id: string; other_id: string; other_name: string; confidence: number; reasons: { reasons: string[]; conflicts: string[] } }>(sql`
        select d.id, case when d.prospect_a = ${id} then d.prospect_b else d.prospect_a end as other_id, o.business_name as other_name, d.confidence, d.reasons
        from possible_duplicates d join prospects o on o.id = case when d.prospect_a = ${id} then d.prospect_b else d.prospect_a end
        where (d.prospect_a = ${id} or d.prospect_b = ${id}) and d.status = 'pending'`),
      q.many<{ type: string; occurred_at: Date; match_method: string; plan: string | null }>(sql`select type, occurred_at, match_method, plan from conversions where prospect_id = ${id} order by occurred_at`),
      q.many<{ id: string; name: string }>(sql`select id, name from campaigns where status <> 'archived' order by created_at desc`),
    ]);
    return { p, research, messages, events, followups, notes, campaigns, sources, conversations, duplicates, conversions, allCampaigns };
  });
  if (!data) notFound();
  const { p } = data;
  const s = (k: string) => p[k] as string | null;
  const num = (k: string) => p[k] as number | null;
  const sr = p.score_reasons;
  const canEdit = can(user, "member");

  const reach: { icon: React.ReactNode; label: string; href: string | null; value: string }[] = [];
  if (s("instagram_handle")) reach.push({ icon: <AtSign />, label: "Instagram", href: profileUrl("instagram", s("instagram_handle")!), value: `@${s("instagram_handle")}${num("follower_count") != null ? ` · ${fmtCompact(num("follower_count"))} followers` : ""}` });
  if (s("tiktok_handle")) reach.push({ icon: <Music2 />, label: "TikTok", href: profileUrl("tiktok", s("tiktok_handle")!), value: `@${s("tiktok_handle")}` });
  if (s("whatsapp") || s("phone")) reach.push({ icon: <Phone />, label: s("whatsapp") ? "WhatsApp" : "Phone", href: null, value: (s("whatsapp") ?? s("phone"))! });
  if (s("email")) reach.push({ icon: <Mail />, label: "Email", href: `mailto:${s("email")}`, value: s("email")! });
  if (s("website")) reach.push({ icon: <Globe />, label: "Website", href: s("website"), value: s("website_domain") ?? s("website")! });
  if (s("booking_url")) reach.push({ icon: <Link2 />, label: "Booking link", href: s("booking_url"), value: s("booking_url")!.replace(/^https?:\/\//, "") });

  return (
    <>
      <div className="border-b border-border bg-surface/60 px-4 pb-4 pt-3 md:px-6">
        <Link href="/prospects" className="inline-flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg"><ArrowLeft className="size-3.5" /> Prospects</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[20px] font-semibold tracking-tight">{p.business_name}</h1>
              <StatusBadge status={p.status} />
              {p.is_demo ? <Badge>demo data</Badge> : null}
              {p.do_not_contact ? <Badge tone="danger">Do not contact · {String(p.dnc_reason ?? "").replace("_", " ")}</Badge> : null}
            </div>
            <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-fg-3">
              <span>{categoryLabel(s("category"))}</span>
              {s("city") ? <span className="inline-flex items-center gap-1"><MapPin className="size-3" />{[s("area"), s("city")].filter(Boolean).join(", ")}</span> : null}
              {s("owner_name") ? <span>Owner: {s("owner_name")}</span> : null}
              <span>Discovered {timeAgo(p.discovered_at as Date)} via {String(p.source).replace(/_/g, " ")}</span>
            </p>
          </div>
          <div className="flex items-center gap-5">
            <div className="text-right"><div className="text-[11px] uppercase tracking-wide text-fg-3">ICP</div><ScoreBadge score={num("icp_score")} className="text-[18px]" /></div>
            <div className="text-right"><div className="text-[11px] uppercase tracking-wide text-fg-3">Priority</div><div className="text-[18px] font-semibold tabular">{num("priority_score") ?? "—"}</div></div>
            <div className="text-right"><div className="text-[11px] uppercase tracking-wide text-fg-3">Data</div><div className="text-[18px] font-semibold tabular">{num("completeness_score") ?? "—"}%</div></div>
          </div>
        </div>
        {canEdit ? (
          <div className="mt-3">
            <ProspectActions prospect={{ id: p.id, status: p.status, doNotContact: Boolean(p.do_not_contact), isDemo: Boolean(p.is_demo), signedUp: Boolean(p.signed_up) }}
              campaigns={data.allCampaigns} canAdmin={can(user, "admin")} />
          </div>
        ) : null}
      </div>

      <div className="grid gap-4 p-4 md:p-6 xl:grid-cols-[1fr_380px]">
        <div className="min-w-0 space-y-4">
          {data.duplicates.length ? (
            <Panel title="Possible duplicate" description="Review before contacting — never merged automatically">
              <ul className="space-y-2">
                {data.duplicates.map((d) => (
                  <li key={d.id} className="flex flex-wrap items-center gap-2 text-[12.5px]">
                    <Badge tone="warning">{d.confidence}% match</Badge>
                    <Link href={`/prospects/${d.other_id}`} className="font-medium hover:underline">{d.other_name}</Link>
                    <span className="text-fg-3">{d.reasons.reasons.join(" · ")}</span>
                    <Link href="/discover?tab=duplicates" className="ml-auto text-[12px] underline">Review</Link>
                  </li>
                ))}
              </ul>
            </Panel>
          ) : null}

          <ResearchPanel prospectId={p.id} research={data.research} canEdit={canEdit} />

          <Panel title="Why this score" description="Transparent rules — every point is explained">
            {sr ? (
              <div className="grid gap-5 md:grid-cols-2">
                <div className="space-y-2.5">
                  {(Object.keys(COMPONENT_MAX) as Exclude<ScoreComponent, "penalty">[]).map((c) => (
                    <div key={c}>
                      <div className="flex justify-between text-[12px]"><span className="text-fg-2">{COMPONENT_LABELS[c]}</span><span className="tabular text-fg-3">{sr.components[c] ?? 0}/{COMPONENT_MAX[c]}</span></div>
                      <Progress value={sr.components[c] ?? 0} max={COMPONENT_MAX[c]} tone="info" className="mt-1" />
                    </div>
                  ))}
                  {sr.components.penalty ? <p className="text-[12px] text-danger">Adjustments: {sr.components.penalty}</p> : null}
                </div>
                <ul className="space-y-1.5 text-[12.5px]">
                  {sr.reasons.map((r, i) => (
                    <li key={i} className="flex gap-2">
                      <span className={cn("w-8 shrink-0 text-right tabular font-medium", r.kind === "positive" ? "text-success" : r.kind === "negative" ? "text-danger" : "text-fg-3")}>
                        {r.kind === "missing" ? "·" : r.points > 0 ? `+${r.points}` : r.points}
                      </span>
                      <span className={r.kind === "missing" ? "text-fg-3" : "text-fg"}>{r.label}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : <p className="text-[12.5px] text-fg-3">Not scored yet.</p>}
          </Panel>

          <Panel title="Outreach" padded={false} actions={canEdit ? <Link href={`/outreach`} className="text-[12px] text-fg-3 hover:text-fg">Open queue</Link> : null}>
            {data.messages.length === 0 ? <p className="p-4 text-[12.5px] text-fg-3">No messages yet. Use “Generate message” above.</p> : (
              <ul className="divide-y divide-border">
                {data.messages.map((m) => (
                  <li key={m.id} className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-[12px]">
                      <MessageStatusBadge status={m.status} />
                      <ChannelLabel channel={m.channel} />
                      <span className="text-fg-3">{m.kind === "followup" ? `Follow-up ${m.step}` : "First message"} · {m.sent_at ? `sent ${fmtDateTime(m.sent_at)}` : `drafted ${timeAgo(m.created_at)}`}</span>
                      <span className="ml-auto text-[11px] text-fg-3">{m.generator.startsWith("ai:") ? `AI · ${m.generator.slice(3).split("/")[0]}` : m.generator}</span>
                    </div>
                    <p className="mt-1.5 whitespace-pre-wrap text-[13px] text-fg-2">{m.body}</p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel title="Conversation" padded={false} actions={<Link href={`/inbox?p=${p.id}`} className="text-[12px] text-fg-3 hover:text-fg">Open in inbox</Link>}>
            {data.conversations.length === 0 ? <p className="p-4 text-[12.5px] text-fg-3">No conversation yet.</p> : data.conversations.map((c) => (
              <div key={c.id} className="border-b border-border p-4 last:border-0">
                <div className="mb-2 flex items-center gap-2 text-[12px]"><ChannelLabel channel={c.channel} /><IntentBadge intent={c.intent} /><span className="text-fg-3">{c.status.replace("_", " ")}</span></div>
                <div className="space-y-2">
                  {c.messages.map((m, i) => (
                    <div key={i} className={cn("max-w-[85%] rounded-lg px-3 py-2 text-[13px]", m.direction === "outbound" ? "ml-auto bg-surface-3" : "bg-accent-subtle")}>
                      <p className="whitespace-pre-wrap">{m.body}</p>
                      <p className="mt-1 text-[10.5px] text-fg-3">{m.direction === "outbound" ? "You" : p.business_name} · {fmtDateTime(m.occurred_at)}</p>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </Panel>

          <Panel title="Activity" padded={false}>
            <ol className="relative px-4 py-3">
              {data.events.map((e) => (
                <li key={e.id} className="flex gap-3 py-1.5 text-[12.5px]">
                  <span className="w-28 shrink-0 text-[11.5px] tabular text-fg-3">{fmtDateTime(e.created_at)}</span>
                  <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", e.type.startsWith("conversion") ? "bg-success" : e.type.startsWith("reply") ? "bg-accent" : "bg-fg-3")} />
                  <span className="text-fg-2">
                    <span className="text-fg-3">{e.actor_type === "ai" ? "AI " : e.actor_type === "webhook" ? "Orbit " : e.actor_type === "user" ? "You " : ""}</span>
                    {describeEvent(e.type, e.data, e.channel).replace(/^— /, "")}
                  </span>
                </li>
              ))}
              {data.events.length === 0 ? <li className="text-[12.5px] text-fg-3">No activity yet.</li> : null}
            </ol>
          </Panel>
        </div>

        <aside className="space-y-4">
          <Panel title="Contact & profiles">
            {reach.length ? (
              <ul className="space-y-2">
                {reach.map((r) => (
                  <li key={r.label} className="flex items-center gap-2.5 text-[12.5px] [&_svg]:size-3.5">
                    <span className="text-fg-3">{r.icon}</span>
                    <span className="w-20 shrink-0 text-fg-3">{r.label}</span>
                    {r.href && !p.is_demo ? <a href={r.href} target="_blank" rel="noopener noreferrer" className="min-w-0 truncate hover:underline">{r.value} <ExternalLink className="inline size-3 text-fg-3" /></a> : <span className="min-w-0 truncate">{r.value}</span>}
                  </li>
                ))}
              </ul>
            ) : <p className="text-[12.5px] text-fg-3">No contact details yet.</p>}
            {sr?.completeness ? (
              <div className="mt-4 border-t border-border pt-3">
                <div className="flex justify-between text-[12px]"><span className="text-fg-3">Data completeness</span><span className="tabular font-medium">{sr.completeness.score}%</span></div>
                <Progress value={sr.completeness.score} className="mt-1" tone="info" />
                <p className="mt-2 text-[11.5px] text-fg-3">Missing: {sr.completeness.missing.join(", ") || "nothing"}</p>
              </div>
            ) : null}
          </Panel>

          <Panel title="Business">
            <Dl items={[
              ["Category", categoryLabel(s("category"))],
              ["Services", (p.services as string[])?.length ? (p.services as string[]).join(", ") : null],
              ["Bio", s("bio") ? <span className="whitespace-pre-wrap">{s("bio")}</span> : null],
              ["Last post", p.last_post_date ? timeAgo(p.last_post_date as Date) : null],
              ["Posts / week", num("posting_frequency")],
              ["Followers", num("follower_count") != null ? fmtCompact(num("follower_count")) : null],
            ]} />
          </Panel>

          <Panel title="Evidence" description="Where each signal came from">
            {Object.keys(p.signals ?? {}).length ? (
              <ul className="space-y-1.5 text-[12px]">
                {Object.entries(p.signals).map(([k, v]) => (
                  <li key={k}><span className="font-medium">{k.replace(/([A-Z])/g, " $1").toLowerCase()}</span> <span className="text-fg-3">— {v.source}{v.quote ? `: “${v.quote}”` : ""}</span></li>
                ))}
              </ul>
            ) : <p className="text-[12.5px] text-fg-3">No signals extracted.</p>}
          </Panel>

          <Panel title="Follow-ups">
            {data.followups.length ? (
              <ul className="space-y-1.5 text-[12.5px]">
                {data.followups.map((f) => (
                  <li key={f.id} className="flex items-center gap-2">
                    <span className="w-14 text-fg-3">{f.step >= 9 ? "Check-in" : `Step ${f.step}`}</span>
                    <span className="flex-1">{fmtDate(f.due_at, "EEE d MMM")}</span>
                    <Badge tone={f.status === "pending" ? "warning" : f.status === "done" ? "success" : "neutral"}>{f.status === "cancelled" && f.cancel_reason ? `stopped: ${f.cancel_reason.split(":")[0].replace(/_/g, " ")}` : f.status}</Badge>
                  </li>
                ))}
              </ul>
            ) : <p className="text-[12.5px] text-fg-3">Scheduled automatically after the first message is sent.</p>}
          </Panel>

          <Panel title="Conversion">
            <Dl items={[
              ["Visited Orbit", p.visited_product ? "Yes (clicked tracked link)" : "Not yet"],
              ["Signed up", p.signed_up ? fmtDateTime(p.signup_at as Date) : "No"],
              ["Activated", p.activated ? fmtDateTime(p.activation_at as Date) : "No"],
              ["Paid", p.paid ? `${fmtDateTime(p.paid_at as Date)}${s("subscription_plan") ? ` · ${s("subscription_plan")}` : ""}` : "No"],
              ["Matched by", data.conversions[0]?.match_method?.replace("_", " ") ?? null],
            ]} />
          </Panel>

          <Panel title="Campaigns & sources">
            <div className="flex flex-wrap gap-1.5">{data.campaigns.map((c) => <Link key={c.id} href={`/campaigns/${c.id}`}><Badge tone="info">{c.name}</Badge></Link>)}{data.campaigns.length === 0 ? <span className="text-[12.5px] text-fg-3">Not in a campaign</span> : null}</div>
            <ul className="mt-3 space-y-1 text-[12px] text-fg-3">{data.sources.map((x, i) => <li key={i}>{x.source.replace(/_/g, " ")} · {fmtDate(x.discovered_at)}{x.source_url && !p.is_demo ? <> · <a className="underline" href={x.source_url} target="_blank" rel="noopener noreferrer">source</a></> : null}</li>)}</ul>
          </Panel>

          <Panel title="Notes">
            {canEdit ? <NoteForm prospectId={p.id} /> : null}
            <ul className="mt-3 space-y-2.5">
              {data.notes.map((n) => <li key={n.id} className="text-[12.5px]"><p className="whitespace-pre-wrap">{n.body}</p><p className="text-[11px] text-fg-3">{n.name ?? "Someone"} · {timeAgo(n.created_at)}</p></li>)}
            </ul>
          </Panel>
        </aside>
      </div>
    </>
  );
}

