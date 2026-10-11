import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, ExternalLink } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { getEmailSettings, recipientEligibility } from "@/server/email/policy";
import { PageHeader, Panel, Badge, ScoreBadge } from "@/components/ui/display";
import { MessageStatusBadge } from "@/components/ui/status";
import { EmailStatusBadge } from "@/components/email-status";
import { categoryLabel } from "@/server/domain/taxonomy";
import { fmtDate, timeAgo } from "@/lib/utils";
import { Composer, type ComposerData } from "./composer";

export const metadata = { title: "Compose email" };

export default async function ComposePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireUser();
  const data = await asUser(user, async (q) => {
    const m = await q.maybe<{
      id: string; prospect_id: string; campaign_id: string | null; channel: string; kind: string; step: number; subject: string | null; body: string; status: string;
      validation: { ok: boolean; issues: { code: string; severity: string; message: string }[] }; sender_account_id: string | null; error: string | null;
      provider_message_id: string | null; sent_at: Date | null; delivery_status: string | null; suggested_followup_at: Date | null; generator: string;
      campaign_name: string | null; campaign_code: string | null; followup_days: number[] | null; tracked_url: string | null; utm: Record<string, string> | null;
    }>(sql`
      select m.id, m.prospect_id, m.campaign_id, m.channel, m.kind, m.step, m.subject, m.body, m.status, m.validation, m.sender_account_id, m.error,
        m.provider_message_id, m.sent_at, m.delivery_status, m.suggested_followup_at, m.generator,
        c.name as campaign_name, c.code as campaign_code, c.followup_days, t.destination_url as tracked_url, t.utm
      from outreach_messages m left join campaigns c on c.id = m.campaign_id left join tracked_links t on t.id = m.tracked_link_id
      where m.id = ${id}`);
    if (!m) return null;
    const p = await q.one<{
      id: string; business_name: string; owner_name: string | null; category: string | null; city: string | null; country: string | null; website: string | null;
      email: string | null; email_status: string; email_source: string | null; email_source_url: string | null; email_discovered_at: Date | null;
      icp_score: number | null; score_reasons: { label?: string; points?: number; reason?: string }[] | null; source: string; source_url: string | null;
      instagram_handle: string | null; phone: string | null; description: string | null; do_not_contact: boolean; bounced: boolean; unsubscribed: boolean; status: string;
    }>(sql`
      select id, business_name, owner_name, category, city, country, website, email, email_status, email_source, email_source_url, email_discovered_at,
        icp_score, score_reasons, source, source_url, instagram_handle, phone, description, do_not_contact, bounced, unsubscribed, status
      from prospects where id = ${m.prospect_id}`);
    const contacts = await q.many<{ value: string; is_primary: boolean; is_role: boolean; source: string | null; source_url: string | null; verification_status: string | null }>(sql`
      select value, is_primary, is_role, source, source_url, verification_status from prospect_contacts where prospect_id = ${p.id} and kind = 'email' order by is_primary desc, is_role, value`);
    const research = await q.maybe<{ summary: string; statements: { text?: string; statement?: string; kind: string; basis?: string[] }[]; why_relevant: string[]; created_at: Date; generator: string }>(sql`
      select summary, coalesce(statements->'statements', '[]'::jsonb) as statements, why_relevant, created_at, generator
      from prospect_research where prospect_id = ${p.id} order by created_at desc limit 1`);
    const accounts = await q.many<{ id: string; email_address: string | null; label: string; provider: string; status: string }>(sql`
      select id, email_address, label, provider, status from sender_accounts where channel = 'email' and is_active order by created_at`);
    const settings = await getEmailSettings(q, user.workspaceId);
    const elig = await recipientEligibility(q, p, settings);
    const history = await q.many<{ id: string; kind: string; step: number; status: string; subject: string | null; sent_at: Date | null; created_at: Date }>(sql`
      select id, kind, step, status, subject, sent_at, created_at from outreach_messages where prospect_id = ${p.id} and channel = 'email' and id <> ${id} order by created_at desc limit 6`);
    return { m, p, contacts, research, accounts, settings, elig, history };
  });
  if (!data) notFound();
  const { m, p } = data;
  if (m.channel !== "email") {
    return (
      <div className="p-6"><Panel><p className="text-[13px]">This draft is for {m.channel}. Open it from <Link className="underline" href="/outreach">Send Queue</Link>.</p></Panel></div>
    );
  }
  const followupDays = m.followup_days?.length ? m.followup_days : [3, 7];
  const followupDate = m.suggested_followup_at ?? (m.kind === "initial" ? new Date(Date.now() + followupDays[0] * 86_400_000) : null);
  const composer: ComposerData = {
    id: m.id, prospectId: p.id, status: m.status, subject: m.subject ?? "", body: m.body, kind: m.kind, step: m.step,
    to: p.email, toStatus: p.email_status, contacts: data.contacts.map((c) => ({ value: c.value, status: c.verification_status ?? "unverified", isRole: c.is_role })),
    accounts: data.accounts.map((a) => ({ id: a.id, label: a.email_address ?? a.label, provider: a.provider, status: a.status })),
    senderAccountId: m.sender_account_id, error: m.error, issues: m.validation?.issues ?? [],
    eligibility: data.elig.ok ? null : data.elig.reasons.join(" · "),
    needsVerification: data.elig.needsVerification,
    footerPreview: [data.settings.sender.senderName, data.settings.sender.company, data.settings.sender.address].filter(Boolean).join(" · "),
    sentAt: m.sent_at ? m.sent_at.toISOString() : null, providerMessageId: m.provider_message_id, deliveryStatus: m.delivery_status,
    defaultTestTo: user.email,
  };

  const facts = (data.research?.statements ?? []).filter((s) => s.kind === "fact");
  const inferences = (data.research?.statements ?? []).filter((s) => s.kind === "inference");
  const unknowns = [
    !p.owner_name && "Owner's name",
    p.email_status !== "verified" && "Whether the mailbox is monitored (email not verified)",
    !p.website && "Website",
    !p.description && "What services they offer in detail",
  ].filter(Boolean) as string[];

  return (
    <>
      <PageHeader
        title={`${m.kind === "followup" ? `Follow-up ${m.step}` : "Email"} to ${p.business_name}`}
        description={<span className="inline-flex flex-wrap items-center gap-2"><MessageStatusBadge status={m.status} />{m.campaign_name ? <span>{m.campaign_name}{m.campaign_code ? ` · ${m.campaign_code}` : ""}</span> : <span>No campaign</span>}<span className="text-fg-3">Drafted by {m.generator.replace(/^ai:/, "AI · ")}</span></span>}
        actions={<Link href="/outreach" className="inline-flex items-center gap-1 text-[12.5px] text-fg-2 hover:text-fg"><ArrowLeft className="size-3.5" /> Send Queue</Link>}
      />
      <div className="grid gap-4 p-4 md:p-6 xl:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          <Composer data={composer} canEdit={can(user, "member")} />
          <Panel title="Tracking">
            <dl className="grid gap-2 text-[12.5px] sm:grid-cols-2">
              <div><dt className="text-fg-3">Link in email</dt><dd className="break-all">{m.tracked_url ?? "No tracked link (set a signup URL in Settings)"}</dd></div>
              <div><dt className="text-fg-3">UTM / campaign id</dt><dd>{m.utm && Object.keys(m.utm).length ? Object.entries(m.utm).map(([k, v]) => `${k}=${v}`).join(" · ") : m.campaign_code ?? "—"}</dd></div>
              <div><dt className="text-fg-3">Follow-up if no reply</dt><dd>{followupDate ? fmtDate(followupDate) : "—"} <span className="text-fg-3">(stops on reply, bounce or unsubscribe)</span></dd></div>
              <div><dt className="text-fg-3">Unsubscribe</dt><dd>One-click link + List-Unsubscribe header added automatically</dd></div>
            </dl>
          </Panel>
          {data.history.length ? (
            <Panel title="Other emails to this business" padded={false}>
              <ul className="divide-y divide-border">{data.history.map((h) => (
                <li key={h.id} className="flex items-center gap-2 px-4 py-2 text-[12.5px]">
                  <MessageStatusBadge status={h.status} />
                  <Link href={`/outreach/compose/${h.id}`} className="min-w-0 flex-1 truncate hover:underline">{h.subject ?? "(no subject)"}</Link>
                  <span className="text-fg-3">{h.kind === "followup" ? `Follow-up ${h.step}` : "First"} · {timeAgo(h.sent_at ?? h.created_at)}</span>
                </li>
              ))}</ul>
            </Panel>
          ) : null}
        </div>

        <aside className="space-y-4">
          <Panel title="Business">
            <div className="space-y-2 text-[12.5px]">
              <div className="flex items-center justify-between gap-2"><Link href={`/prospects/${p.id}`} className="font-medium hover:underline">{p.business_name}</Link><ScoreBadge score={p.icp_score} /></div>
              <p className="text-fg-2">{categoryLabel(p.category)} · {p.city ?? "—"}{p.country ? `, ${p.country}` : ""}</p>
              {p.website ? <a href={p.website} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 break-all text-fg-2 underline">{p.website.replace(/^https?:\/\//, "")} <ExternalLink className="size-3" /></a> : null}
              <div className="rounded-md bg-surface-2 p-2">
                <div className="flex items-center gap-2"><span className="break-all font-medium">{p.email ?? "No email"}</span><EmailStatusBadge status={p.email ? p.email_status : "none"} /></div>
                {p.email ? (
                  <p className="mt-1 text-[11.5px] text-fg-3">
                    Source: {p.email_source ?? "unknown"}{p.email_source_url ? <> · <a href={p.email_source_url} target="_blank" rel="noreferrer" className="underline">page</a></> : null}
                    {p.email_discovered_at ? ` · found ${timeAgo(p.email_discovered_at)}` : ""}
                  </p>
                ) : null}
              </div>
              <p className="text-[11.5px] text-fg-3">Discovered via {p.source.replace(/_/g, " ")}{p.source_url ? <> · <a href={p.source_url} target="_blank" rel="noreferrer" className="underline">record</a></> : null}</p>
            </div>
          </Panel>
          <Panel title="Research" actions={<Link href={`/prospects/${p.id}`} className="text-[12px] text-fg-3 hover:text-fg">Full profile</Link>}>
            {data.research ? (
              <div className="space-y-3 text-[12.5px]">
                <p className="text-fg-2">{data.research.summary}</p>
                {facts.length ? <Section title="Facts (from public data)" items={facts.map((s) => s.text ?? s.statement ?? "")} tone="success" /> : null}
                {inferences.length ? <Section title="Inferences (not confirmed)" items={inferences.map((s) => s.text ?? s.statement ?? "")} tone="warning" /> : null}
                <Section title="Unknown" items={unknowns} tone="neutral" />
                <p className="text-[11px] text-fg-3">{data.research.generator} · {timeAgo(data.research.created_at)}</p>
              </div>
            ) : (
              <div className="space-y-3 text-[12.5px]">
                <p className="text-fg-3">No AI research yet. Generate it from the full profile.</p>
                <Section title="Unknown" items={unknowns} tone="neutral" />
              </div>
            )}
          </Panel>
          {p.score_reasons?.length ? (
            <Panel title="Why this score">
              <ul className="space-y-1 text-[12px]">{p.score_reasons.slice(0, 8).map((r, i) => (
                <li key={i} className="flex justify-between gap-2"><span className="text-fg-2">{r.label ?? r.reason}</span>{r.points != null ? <span className="tabular text-fg-3">{r.points > 0 ? "+" : ""}{r.points}</span> : null}</li>
              ))}</ul>
            </Panel>
          ) : null}
        </aside>
      </div>
    </>
  );
}

function Section({ title, items, tone }: { title: string; items: string[]; tone: "success" | "warning" | "neutral" }) {
  if (!items.length) return null;
  return (
    <div>
      <Badge tone={tone}>{title}</Badge>
      <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-fg-2">{items.map((t, i) => <li key={i}>{t}</li>)}</ul>
    </div>
  );
}
