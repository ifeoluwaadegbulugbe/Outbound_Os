import Link from "next/link";
import { Sparkles } from "lucide-react";
import { requireUser, asUser } from "@/server/auth/session";
import { sql } from "@/server/db";
import { funnel, scopeWhere, safeRate } from "@/server/services/metrics";
import { breakdown, dailySeries, DIMENSIONS, type Dimension, type BreakdownRow } from "@/server/services/breakdowns";
import { computeInsights, MIN_SAMPLE } from "@/server/services/insights";
import { PageHeader, Panel } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { FunnelChart } from "@/components/funnel";
import { DailyBars, RateBar } from "@/components/charts";
import { categoryLabel, CHANNEL_LABELS, MESSAGE_ANGLES, type Channel } from "@/server/domain/taxonomy";
import { cn, fmtNum } from "@/lib/utils";
import { emailFunnel, emailStats, emailByCountry, EMAIL_FUNNEL } from "@/server/services/email-metrics";
import { EmailKpis } from "@/components/email-kpis";

export const metadata = { title: "Analytics" };

const RANGES = [{ key: "7", label: "7 days" }, { key: "30", label: "30 days" }, { key: "90", label: "90 days" }, { key: "all", label: "All time" }];
const BREAKDOWNS: Dimension[] = ["category", "city", "channel", "variant", "angle", "source", "booking_link"];

function label(dim: Dimension, key: string) {
  if (dim === "category") return categoryLabel(key === "Unknown" ? null : key);
  if (dim === "channel") return CHANNEL_LABELS[key as Channel] ?? key;
  if (dim === "angle") return MESSAGE_ANGLES.find((a) => a.key === key)?.label ?? key;
  if (dim === "source") return key.replace(/_/g, " ");
  return key;
}

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ range?: string; campaign?: string }> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const range = RANGES.some((r) => r.key === sp.range) ? sp.range! : "30";
  const days = range === "all" ? null : Number(range);
  const to = new Date();
  const from = days ? new Date(to.getTime() - (days - 1) * 86_400_000) : null;
  const campaignId = sp.campaign && /^[0-9a-f-]{36}$/i.test(sp.campaign) ? sp.campaign : null;

  const data = await asUser(user, async (q) => {
    const scope = scopeWhere({ campaignId });
    // Cohort = prospects discovered in range; activity series uses event dates.
    const cohort = from ? sql`${scope} and p.discovered_at >= ${from}` : scope;
    const [f, insights, campaigns, earliest] = await Promise.all([
      funnel(q, { campaignId, where: from ? sql`p.discovered_at >= ${from}` : undefined }),
      computeInsights(q, { campaignId, limit: 6 }),
      q.many<{ id: string; name: string }>(sql`select id, name from campaigns where status <> 'archived' order by created_at desc`),
      q.value<Date | null>(sql`select min(discovered_at) from prospects`),
    ]);
    const seriesFrom = from ?? new Date(Math.max((earliest ? new Date(earliest).getTime() : to.getTime()), to.getTime() - 89 * 86_400_000));
    const series = await dailySeries(q, seriesFrom, to, scope);
    const groups: Record<string, BreakdownRow[]> = {};
    for (const d of BREAKDOWNS) groups[d] = await breakdown(q, d, cohort, { contactedOnly: ["channel", "variant", "angle"].includes(d) });
    const escope = { campaignId, from };
    const [ef, es, byCountry] = await Promise.all([emailFunnel(q, escope), emailStats(q, escope), emailByCountry(q, escope)]);
    return { f, insights, campaigns, series, groups, ef, es, byCountry };
  });

  const { f } = data;
  const rates: [string, number, number][] = [
    ["Qualification", f.qualified, f.discovered], ["Contact", f.contacted, f.qualified], ["Reply", f.replied, f.contacted], ["Interest", f.interested, f.replied],
    ["Signup", f.signed_up, f.contacted], ["Activation", f.activated, f.signed_up], ["Paid", f.paid, f.activated],
  ];
  const q = (p: Record<string, string | null>) => {
    const s = new URLSearchParams({ ...(range !== "30" ? { range } : {}), ...(campaignId ? { campaign: campaignId } : {}) });
    for (const [k, v] of Object.entries(p)) v == null ? s.delete(k) : s.set(k, v);
    const str = s.toString();
    return `/analytics${str ? `?${str}` : ""}`;
  };

  return (
    <>
      <PageHeader title="Analytics" description="Every number is computed from your data. Small samples are flagged rather than over-interpreted.">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex rounded-md border border-border bg-surface p-0.5" role="group" aria-label="Date range">
            {RANGES.map((r) => (
              <Link key={r.key} href={q({ range: r.key === "30" ? null : r.key })} className={cn("rounded px-2.5 py-1 text-[12px]", range === r.key ? "bg-surface-3 font-medium" : "text-fg-3 hover:text-fg")}>{r.label}</Link>
            ))}
          </div>
          <div className="flex flex-wrap gap-1">
            <Link href={q({ campaign: null })} className={cn("rounded-md border px-2.5 py-1 text-[12px]", !campaignId ? "border-fg bg-fg text-bg" : "border-border text-fg-2")}>All campaigns</Link>
            {data.campaigns.map((c) => (
              <Link key={c.id} href={q({ campaign: c.id })} className={cn("rounded-md border px-2.5 py-1 text-[12px]", campaignId === c.id ? "border-fg bg-fg text-bg" : "border-border text-fg-2")}>{c.name}</Link>
            ))}
          </div>
        </div>
      </PageHeader>

      <div className="space-y-4 p-4 md:p-6">
        <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
          <Panel title="Email funnel" description={`${from ? `Emails sent in the last ${days} days` : "All time"} · discovery stages show all prospects in scope. Test sends excluded.`}>
            <FunnelChart data={data.ef} stages={EMAIL_FUNNEL} successFrom={9} accentFrom={5} hrefFor={() => `/outreach?tab=sent`} />
          </Panel>
          <EmailKpis es={data.es} title="Email rates" />
        </div>
        {data.byCountry.length ? (
          <Panel padded={false} title="Email results by country">
            <Table>
              <thead><tr><Th>Country</Th><Th>Prospects</Th><Th>With email</Th><Th>Emailed</Th><Th>Reply rate</Th><Th>Signed up</Th></tr></thead>
              <tbody>{data.byCountry.map((r) => (
                <Tr key={r.country}>
                  <Td className="font-medium">{r.country}</Td>
                  <Td className="tabular">{fmtNum(r.prospects)}</Td>
                  <Td className="tabular">{fmtNum(r.with_email)} <span className="text-fg-3">({r.prospects ? Math.round((r.with_email / r.prospects) * 100) : 0}%)</span></Td>
                  <Td className="tabular">{fmtNum(r.sent)}</Td>
                  <Td className="tabular">{r.sent >= MIN_SAMPLE ? `${((r.replied / r.sent) * 100).toFixed(1)}%` : r.sent ? <span className="text-fg-3">{r.replied}/{r.sent} (small sample)</span> : "—"}</Td>
                  <Td className="tabular">{fmtNum(r.signed_up)}</Td>
                </Tr>
              ))}</tbody>
            </Table>
          </Panel>
        ) : null}
        <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
          <Panel title="All-channel funnel" description={from ? `Prospects discovered in the last ${days} days` : "All prospects"}>
            <FunnelChart data={f} hrefFor={(s) => `/prospects?stage=${s}${campaignId ? `&campaign=${campaignId}` : ""}`} />
          </Panel>
          <Panel title="Conversion rates">
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 xl:grid-cols-2">
              {rates.map(([name, n, d]) => {
                const r = safeRate(n, d);
                return (
                  <div key={name}>
                    <dt className="text-[11.5px] text-fg-3">{name} rate</dt>
                    <dd className="text-[18px] font-semibold tabular">{r == null ? "—" : `${(r * 100).toFixed(r < 0.1 ? 1 : 0)}%`}</dd>
                    <dd className="text-[11px] tabular text-fg-3">{fmtNum(n)} of {fmtNum(d)}</dd>
                  </div>
                );
              })}
            </dl>
            <p className="mt-3 border-t border-border pt-2 text-[11.5px] text-fg-3">Signup rate = signups ÷ contacted. North star (qualified → activated): {safeRate(f.activated, f.qualified) == null ? "—" : `${((f.activated / f.qualified) * 100).toFixed(1)}%`}.</p>
          </Panel>
        </div>

        <Panel title="Daily activity" description="Separate scales — each chart has its own axis.">
          <div className="grid gap-6 md:grid-cols-3">
            <DailyBars title="First contacts" points={data.series.map((s) => ({ day: s.day, value: s.contacted }))} />
            <DailyBars title="Replies" points={data.series.map((s) => ({ day: s.day, value: s.replied }))} />
            <DailyBars title="Signups" points={data.series.map((s) => ({ day: s.day, value: s.signed_up }))} />
          </div>
        </Panel>

        <Panel title="Insights" description={`Comparisons need ${MIN_SAMPLE}+ contacted prospects in each group`}>
          {data.insights.length === 0 ? <p className="text-[12.5px] text-fg-3">Not enough data yet to compare groups reliably.</p> : (
            <ul className="grid gap-3 md:grid-cols-2">
              {data.insights.map((i) => (
                <li key={i.id} className="flex gap-2.5 rounded-md border border-border p-3">
                  <Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />
                  <div><p className="text-[13px]">{i.headline}</p><p className="mt-0.5 text-[11.5px] text-fg-3">{i.evidence}</p></div>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <div className="grid gap-4 xl:grid-cols-2">
          {BREAKDOWNS.map((dim) => {
            const rows = data.groups[dim];
            const maxReply = Math.max(0, ...rows.map((r) => (r.contacted ? r.replied / r.contacted : 0)));
            const maxSignup = Math.max(0, ...rows.map((r) => (r.contacted ? r.signed_up / r.contacted : 0)));
            return (
              <Panel key={dim} title={`By ${DIMENSIONS[dim].label.toLowerCase()}`} padded={false}>
                {rows.length === 0 ? <p className="p-4 text-[12.5px] text-fg-3">No data yet.</p> : (
                  <Table>
                    <thead><tr><Th>{DIMENSIONS[dim].label}</Th><Th className="text-right">Contacted</Th><Th>Reply rate</Th><Th>Signup rate</Th><Th className="hidden text-right sm:table-cell">Activated</Th></tr></thead>
                    <tbody>
                      {rows.map((r) => {
                        const low = r.contacted < MIN_SAMPLE;
                        return (
                          <Tr key={r.key}>
                            <Td className="max-w-[180px] truncate">{label(dim, r.key)}{low ? <span className="ml-1 text-[10.5px] text-fg-3" title={`Fewer than ${MIN_SAMPLE} contacted — treat as indicative only`}>low n</span> : null}</Td>
                            <Td className="text-right tabular">{fmtNum(r.contacted)}</Td>
                            <Td><RateBar rate={safeRate(r.replied, r.contacted)} max={maxReply} lowSample={low} /></Td>
                            <Td><RateBar rate={safeRate(r.signed_up, r.contacted)} max={maxSignup} lowSample={low} /></Td>
                            <Td className="hidden text-right tabular sm:table-cell">{fmtNum(r.activated)}</Td>
                          </Tr>
                        );
                      })}
                    </tbody>
                  </Table>
                )}
              </Panel>
            );
          })}
        </div>
      </div>
    </>
  );
}
