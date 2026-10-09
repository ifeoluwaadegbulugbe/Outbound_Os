import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft, Users, Send } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { funnel } from "@/server/services/metrics";
import { computeInsights } from "@/server/services/insights";
import { Panel, Badge, Dl } from "@/components/ui/display";
import { LinkButton } from "@/components/ui/button";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { FunnelChart } from "@/components/funnel";
import { JobProgress } from "@/components/job-progress";
import { categoryLabel, CHANNEL_LABELS, MESSAGE_ANGLES, type Channel } from "@/server/domain/taxonomy";
import { fmtNum, fmtPct, fmtDate, timeAgo } from "@/lib/utils";
import { CampaignControls } from "./controls";
import { CampaignEmailPanel } from "./email-panel";
import { COMPLIANCE_ITEMS, campaignReadiness, getEmailSettings } from "@/server/email/policy";
import { defaultPolicy } from "@/server/domain/locations";

export const metadata = { title: "Campaign" };

export default async function CampaignPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string; added?: string }> }) {
  const user = await requireUser();
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const data = await asUser(user, async (q) => {
    const c = await q.maybe<{ id: string; name: string; status: string; target_description: string | null; categories: string[]; cities: string[]; channels: string[];
      prospect_goal: number | null; objective: string | null; offer: string | null; tone: string | null; instructions: string | null; constraints: Record<string, unknown>;
      start_date: Date | null; end_date: Date | null; created_at: Date; code: string | null; sender_account_id: string | null; daily_send_cap: number | null;
      followup_days: number[] | null; send_window: { days?: number[]; start?: string; end?: string; tz?: string } | null; compliance: Record<string, unknown> | null }>(sql`select * from campaigns where id = ${id}`);
    if (!c) return null;
    const [f, variants, runs, insights] = await Promise.all([
      funnel(q, { campaignId: id }),
      q.many<{ id: string; key: string; name: string; angle: string; sent: number; replied: number; signed: number }>(sql`
        select v.id, v.key, v.name, v.angle,
          count(distinct m.prospect_id) filter (where m.status = 'sent' and m.kind = 'initial')::int as sent,
          count(distinct m.prospect_id) filter (where m.status = 'sent' and m.kind = 'initial' and p.replied_at is not null)::int as replied,
          count(distinct m.prospect_id) filter (where m.status = 'sent' and m.kind = 'initial' and p.signed_up)::int as signed
        from message_variants v
        left join outreach_messages m on m.variant_id = v.id
        left join prospects p on p.id = m.prospect_id
        where v.campaign_id = ${id} group by v.id order by v.key`),
      q.many<{ id: string; adapter: string; status: string; found: number; created: number; merged: number; duplicates_flagged: number; created_at: Date; job_id: string | null; error: string | null }>(sql`
        select id, adapter, status, found, created, merged, duplicates_flagged, created_at, job_id, error from discovery_runs where campaign_id = ${id} order by created_at desc limit 5`),
      computeInsights(q, { campaignId: id, limit: 3 }),
    ]);
    const settings = await getEmailSettings(q, user.workspaceId);
    const readiness = await campaignReadiness(q, id, settings);
    const costs = await q.many<{ id: string; label: string; amount: number; currency: string; incurred_on: string }>(sql`
      select id, label, amount::float8 as amount, currency, incurred_on::text from costs where campaign_id = ${id} order by incurred_on desc`);
    const accounts = await q.many<{ id: string; label: string; status: string }>(sql`
      select id, coalesce(email_address, label) as label, status from sender_accounts where channel = 'email' and is_active order by created_at`);
    const countryRows = await q.many<{ country: string; prospects: number; with_email: number; cold_email: string | null; name: string | null }>(sql`
      select g.country, g.prospects, g.with_email,
        (select cold_email from country_policies cp where cp.country_code = g.country) as cold_email,
        (select max(country_name) from locations l where l.country_code = g.country) as name
      from (
        select coalesce(p.country, ${settings.defaultCountry}) as country, count(*)::int as prospects, count(*) filter (where p.email is not null)::int as with_email
        from campaign_prospects x join prospects p on p.id = x.prospect_id where x.campaign_id = ${id} group by 1
      ) g order by g.prospects desc`);
    const countries = countryRows.map((r) => ({ country: r.country, name: r.name ?? r.country, prospects: r.prospects, with_email: r.with_email, cold_email: r.cold_email ?? defaultPolicy(r.country).cold_email }));
    return { c, f, variants, runs, insights, readiness, costs, accounts, countries };
  });
  if (!data) notFound();
  const { c, f } = data;

  return (
    <>
      <div className="border-b border-border bg-surface/60 px-4 pb-4 pt-3 md:px-6">
        <Link href="/campaigns" className="inline-flex items-center gap-1 text-[12px] text-fg-3 hover:text-fg"><ArrowLeft className="size-3.5" /> Campaigns</Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-[20px] font-semibold tracking-tight">{c.name}</h1>
              <Badge tone={c.status === "active" ? "success" : c.status === "paused" ? "warning" : "neutral"} dot>{c.status}</Badge>
            </div>
            <p className="mt-1 text-[12.5px] text-fg-3">
              {c.categories.map(categoryLabel).join(", ") || "Any category"} · {c.cities.join(", ") || "Any city"} · {c.channels.map((x) => CHANNEL_LABELS[x as Channel] ?? x).join(" → ")}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <LinkButton href={`/prospects?campaign=${c.id}`} size="sm"><Users /> {fmtNum(f.discovered)} prospects</LinkButton>
            <LinkButton href={`/prospects?campaign=${c.id}&f=${encodeURIComponent(Buffer.from(JSON.stringify({ op: "and", children: [{ field: "contacted", cmp: "is_false" }, { field: "do_not_contact", cmp: "is_false" }] })).toString("base64url"))}&sort=priority`} size="sm" variant="primary"><Send /> Draft messages</LinkButton>
          </div>
        </div>
        {sp.created ? <p className="mt-3 rounded-md bg-success-subtle px-3 py-2 text-[12.5px] text-success">Campaign created · {fmtNum(Number(sp.added ?? 0))} existing prospects added. Discovery runs in the background — you can keep working.</p> : null}
        {can(user, "member") ? <div className="mt-3"><CampaignControls campaign={{ id: c.id, status: c.status, instructions: c.instructions, tone: c.tone, offer: c.offer, constraints: c.constraints }} /></div> : null}
      </div>

      <div className="grid gap-4 p-4 md:p-6 xl:grid-cols-[1.3fr_1fr]">
        <div className="space-y-4">
          <Panel title="Funnel" description={c.prospect_goal ? `Goal: ${fmtNum(c.prospect_goal)} prospects${c.end_date ? ` by ${fmtDate(c.end_date)}` : ""}` : undefined}>
            <FunnelChart data={f} hrefFor={(s) => `/prospects?campaign=${c.id}&stage=${s}`} />
          </Panel>
          <Panel title="Message variants" description="First messages only. Reply rate = replied ÷ contacted with that variant." padded={false}>
            <Table>
              <thead><tr><Th>Variant</Th><Th>Angle</Th><Th>Contacted</Th><Th>Reply rate</Th><Th>Signup rate</Th></tr></thead>
              <tbody>
                {data.variants.map((v) => (
                  <Tr key={v.id}>
                    <Td><span className="font-medium">{v.key}</span> <span className="text-fg-2">— {v.name}</span></Td>
                    <Td className="text-fg-2">{MESSAGE_ANGLES.find((a) => a.key === v.angle)?.label ?? v.angle}</Td>
                    <Td className="tabular">{fmtNum(v.sent)}</Td>
                    <Td className="tabular">{fmtPct(v.replied, v.sent)}</Td>
                    <Td className="tabular">{fmtPct(v.signed, v.sent)}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-border px-4 py-2 text-[11.5px] text-fg-3">Small samples are noisy — wait for 30+ contacted per variant before drawing conclusions.</p>
          </Panel>
        </div>
        <div className="space-y-4">
          <CampaignEmailPanel canEdit={can(user, "member")} isAdmin={can(user, "admin")} accounts={data.accounts}
            items={COMPLIANCE_ITEMS.map((i) => ({ key: i.key as string, label: i.label, help: i.help }))}
            c={{
              id: c.id, code: c.code, senderAccountId: c.sender_account_id, dailySendCap: c.daily_send_cap, followupDays: c.followup_days ?? [3, 7],
              window: { days: [1, 2, 3, 4, 5, 6], start: "08:00", end: "19:00", tz: "Africa/Lagos", ...(c.send_window ?? {}) },
              compliance: c.compliance ?? {}, costs: data.costs, countries: data.countries, missing: data.readiness.missing,
            }} />
          <Panel title="Insights">
            {data.insights.length ? (
              <ul className="space-y-2.5 text-[13px]">{data.insights.map((i) => <li key={i.id}><p>{i.headline}</p><p className="text-[11.5px] text-fg-3">{i.evidence}</p></li>)}</ul>
            ) : <p className="text-[12.5px] text-fg-3">Not enough data yet (needs 30+ contacted per group).</p>}
          </Panel>
          <Panel title="Discovery runs" actions={<LinkButton href={`/discover?campaign=${c.id}`} size="xs" variant="ghost">Run discovery</LinkButton>}>
            {data.runs.length === 0 ? <p className="text-[12.5px] text-fg-3">No discovery runs yet.</p> : (
              <ul className="space-y-3">
                {data.runs.map((r) => (
                  <li key={r.id}>
                    {r.status === "running" || r.status === "queued" ? (
                      <JobProgress jobId={r.job_id} title={`Discovery · ${r.adapter.replace(/_/g, " ")}`} />
                    ) : (
                      <div className="text-[12.5px]">
                        <div className="flex items-center gap-2"><span className="font-medium">{r.adapter.replace(/_/g, " ")}</span><Badge tone={r.status === "succeeded" ? "success" : r.status === "failed" ? "danger" : "neutral"}>{r.status}</Badge><span className="ml-auto text-[11.5px] text-fg-3">{timeAgo(r.created_at)}</span></div>
                        <p className="text-fg-3">{fmtNum(r.found)} found · {fmtNum(r.created)} new · {fmtNum(r.merged)} matched · {fmtNum(r.duplicates_flagged)} possible duplicates</p>
                        {r.error ? <p className="text-danger">{r.error}</p> : null}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Panel>
          <Panel title="Brief">
            <Dl items={[
              ["Target", c.target_description],
              ["Objective", c.objective],
              ["Offer", c.offer],
              ["Tone", c.tone],
              ["Instructions", c.instructions],
              ["Max length", c.constraints?.maxChars ? `${c.constraints.maxChars} characters` : null],
              ["Dates", `${c.start_date ? fmtDate(c.start_date) : "—"} → ${c.end_date ? fmtDate(c.end_date) : "open"}`],
            ]} />
          </Panel>
        </div>
      </div>
    </>
  );
}
