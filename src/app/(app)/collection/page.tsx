import { requireUser, asUser, can } from "@/server/auth/session";
import { collectionMetrics } from "@/server/collection/metrics";
import { getCollectionSettings } from "@/server/collection/engine";
import { COLLECTION_COUNTRIES, COUNTRY_BY_CC } from "@/server/collection/countries";
import { COLLECTION_SOURCES } from "@/server/collection/sources";
import { manualQueries } from "@/server/collection/queries";
import { NG_STATE_CITIES } from "@/server/collection/ng-states";
import { AFRICAN_CITIES } from "@/server/domain/locations";
import { categoryLabel } from "@/server/domain/taxonomy";
import { PageHeader, Panel, Progress } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { fmtNum, timeAgo } from "@/lib/utils";
import { CollectionControls, ManualQueries } from "./controls";

export const metadata = { title: "Collection" };
export const dynamic = "force-dynamic";

export default async function CollectionPage() {
  const user = await requireUser();
  const { m, settings } = await asUser(user, async (q) => ({ m: await collectionMetrics(q), settings: await getCollectionSettings(q, user.workspaceId) }));
  const pct = Math.min(100, (m.businesses / settings.target) * 100);
  const name = (cc: string) => COUNTRY_BY_CC.get(cc)?.name ?? cc;
  // Every Nigerian state's main cities first (weakest-covered states at the top), then other African cities.
  const covered = new Map(m.ngStates.map((x) => [x.state, x.businesses]));
  const ngGroups = Object.entries(NG_STATE_CITIES).sort((a, b) => (covered.get(a[0]) ?? 0) - (covered.get(b[0]) ?? 0))
    .flatMap(([state, cities]) => cities.map((city) => ({ place: `${city}, ${state} (${fmtNum(covered.get(state) ?? 0)} so far)`, queries: manualQueries(city, "Nigeria") })));
  const groups = [...ngGroups, ...AFRICAN_CITIES.filter((c) => c.country_code !== "NG").map((c) => ({ place: `${c.city}, ${c.country_name}`, queries: manualQueries(c.city, c.country_name) }))];

  return (
    <>
      <PageHeader title="Collection" description="Every number below is a count of real rows in the database. Businesses and emails are counted separately; duplicates, demo data and guessed addresses are never counted." />
      <div className="space-y-4 p-4 md:p-6">
        <Panel>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="text-[12px] text-fg-3">Unique businesses vs target</p>
              <p className="text-[28px] font-semibold tabular tracking-tight">{fmtNum(m.businesses)} <span className="text-[15px] font-normal text-fg-3">/ {fmtNum(settings.target)}</span></p>
            </div>
            <p className="text-[13px] text-fg-2">{pct.toFixed(1)}% · {fmtNum(Math.max(0, settings.target - m.businesses))} to go</p>
          </div>
          <Progress value={pct} className="mt-2" />
        </Panel>

        <section className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-8">
          {[
            ["Businesses", m.businesses],
            ["With website", m.withWebsite],
            ["With public email", m.withEmail],
            ["Email addresses", m.emailAddresses],
            ["Email domain has MX", m.email.domainMxPresent],
            ["Deliverability unknown", m.email.deliverabilityUnknown],
            ["Eligible for outreach", m.eligibleForOutreach],
            ["Duplicates merged", m.duplicatesRemoved],
          ].map(([k, v]) => (
            <div key={k as string} className="rounded-lg border border-border bg-surface p-3 shadow-sm">
              <div className="text-[11.5px] text-fg-3">{k}</div>
              <div className="mt-1 text-[20px] font-semibold tabular">{fmtNum(v as number)}</div>
            </div>
          ))}
        </section>

        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Email status" padded={false} description="One row per business (its primary email). DNS checks are free; only a verification provider can mark an address verified.">
            <Table><tbody>{[
              ["Publicly found (with source evidence)", m.email.publiclyFound],
              ["Syntax-valid", m.email.syntaxValid],
              ["Domain has mail servers (MX)", m.email.domainMxPresent],
              ["Deliverability unknown", m.email.deliverabilityUnknown],
              ["Catch-all or uncertain", m.email.catchAllOrUncertain],
              ["Verified (provider)", m.email.verified],
              ["Invalid / bounced", m.email.invalid],
              ["Not checked yet (queued)", m.email.notCheckedYet],
              ["Needs review (address shared by several businesses)", m.email.needsReview],
              ["Suppressed (opted out / do not contact)", m.email.suppressed],
              ["No public email found", m.email.noPublicEmailFound],
            ].map(([k, v]) => <Tr key={k as string}><Td className="text-fg-2">{k}</Td><Td className="text-right tabular font-medium">{fmtNum(v as number)}</Td></Tr>)}</tbody></Table>
          </Panel>
          <Panel title="Queues" padded={false}>
            <Table><tbody>
              <Tr><Td className="text-fg-2">Discovery units done / remaining</Td><Td className="text-right tabular">{fmtNum(m.units.done)} / {fmtNum(m.units.pending + m.units.running)}</Td></Tr>
              <Tr><Td className="text-fg-2">Units retrying with backoff · dead-lettered</Td><Td className="text-right tabular">{fmtNum(m.units.failed)} · {fmtNum(m.units.dead)}</Td></Tr>
              <Tr><Td className="text-fg-2">Instagram: handles without email to look up · read · emails found in bios</Td><Td className="text-right tabular">{fmtNum(m.instagram.pool)} · {fmtNum(m.instagram.checked)} · {fmtNum(m.instagram.emails)}</Td></Tr>
              <Tr><Td className="text-fg-2">Websites awaiting crawl</Td><Td className="text-right tabular">{fmtNum(m.crawl.pending)}</Td></Tr>
              <Tr><Td className="text-fg-2">Websites crawled: email found · none · robots-blocked</Td><Td className="text-right tabular">{fmtNum(m.crawl.ok)} · {fmtNum(m.crawl.noEmail)} · {fmtNum(m.crawl.blocked)}</Td></Tr>
              <Tr><Td className="text-fg-2">Listed website no longer exists (domain doesn&apos;t resolve)</Td><Td className="text-right tabular">{fmtNum(m.crawl.deadDomain)}</Td></Tr>
              <Tr><Td className="text-fg-2">Crawl errors (retried up to 3×) · skipped social links</Td><Td className="text-right tabular">{fmtNum(m.crawl.error)} · {fmtNum(m.crawl.skipped)}</Td></Tr>
            </tbody></Table>
          </Panel>
        </div>

        <CollectionControls settings={settings} canAdmin={can(user, "admin")}
          countries={COLLECTION_COUNTRIES.map((c) => ({ cc: c.cc, name: c.name }))}
          sources={Object.values(COLLECTION_SOURCES).map((s) => ({ key: s.key, label: s.label, description: s.description, license: s.license }))} />

        <Panel title="Yield per source (work units)" padded={false}>
          <Table>
            <thead><tr><Th>Source</Th><Th>Units done</Th><Th>Records found</Th><Th>New businesses</Th><Th>Duplicates</Th><Th>With email</Th><Th>Retrying · dead</Th><Th>Avg time</Th></tr></thead>
            <tbody>{m.unitYield.map((s) => (
              <Tr key={s.source}>
                <Td className="font-medium">{COLLECTION_SOURCES[s.source]?.label ?? s.source}</Td>
                <Td className="tabular">{fmtNum(s.done)} / {fmtNum(s.units)}</Td><Td className="tabular">{fmtNum(s.found)}</Td><Td className="tabular">{fmtNum(s.created)}</Td>
                <Td className="tabular">{fmtNum(s.merged)}</Td><Td className="tabular">{fmtNum(s.with_email)}</Td><Td className="tabular">{s.failed} · {s.dead}</Td>
                <Td className="tabular">{s.avg_secs != null ? `${s.avg_secs}s` : "—"}</Td>
              </Tr>
            ))}</tbody>
          </Table>
        </Panel>

        <Panel padded={false} title={`Nigeria by state · ${(m.ngShare * 100).toFixed(1)}% of all businesses (target ≥ ${Math.round((settings.countryShare?.share ?? 0) * 100)}%)`}
          description="State from each business's coordinates (official state boundaries). All 36 states and the FCT are listed, including any with none yet.">
          <div className="grid gap-x-6 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {m.ngStates.map((s) => (
              <div key={s.state} className="flex items-baseline justify-between border-b border-border py-1 text-[12.5px]">
                <span className={s.businesses === 0 ? "text-danger" : "text-fg-2"}>{s.state}</span>
                <span className="tabular">{fmtNum(s.businesses)} <span className="text-fg-3">· {fmtNum(s.with_email)} email</span></span>
              </div>
            ))}
          </div>
        </Panel>

        <div className="grid gap-4 xl:grid-cols-3">
          <Breakdown title="By country" rows={m.byCountry.map((r) => [name(r.country), r.businesses, r.with_email])} />
          <Breakdown title="By city (top 25)" rows={m.byCity.map((r) => [`${r.city}${r.country ? `, ${r.country}` : ""}`, r.businesses, r.with_email])} />
          <Breakdown title="By category" rows={m.byCategory.map((r) => [categoryLabel(r.category), r.businesses, r.with_email])} />
        </div>

        <div className="grid gap-4 xl:grid-cols-3">
          <Breakdown title="Businesses by source" rows={m.bySource.map((r) => [r.source.replace(/_/g, " "), r.businesses, r.with_email])} />
          <Panel title="New businesses per hour (48h)" padded={false}>
            <Table><tbody>{m.perHour.length ? m.perHour.map((h) => <Tr key={h.hour}><Td className="text-fg-2">{h.hour}</Td><Td className="text-right tabular">{fmtNum(h.created)}</Td></Tr>)
              : <Tr><Td className="text-fg-3">No new businesses in the last 48 hours.</Td></Tr>}</tbody></Table>
          </Panel>
          <Panel title="Failures & zero-result units" padded={false}>
            <ul className="divide-y divide-border text-[12px]">
              {m.recentErrors.map((e) => (
                <li key={e.unit_key} className="px-4 py-2"><span className="font-medium">{e.unit_key}</span> <span className="text-fg-3">· {e.status} · attempt {e.attempts}{e.status === "failed" ? ` · retry ${timeAgo(e.next_attempt_at)}` : ""}</span><p className="truncate text-danger" title={e.last_error ?? ""}>{e.last_error}</p></li>
              ))}
              {m.zeroYield.map((z) => <li key={z.unit_key} className="px-4 py-2"><span className="font-medium">{z.unit_key}</span><p className="text-fg-3">{z.diagnostic ?? "0 results"}</p></li>)}
              {!m.recentErrors.length && !m.zeroYield.length ? <li className="px-4 py-3 text-fg-3">None.</li> : null}
            </ul>
          </Panel>
        </div>

        <ManualQueries groups={groups} />
      </div>
    </>
  );
}

function Breakdown({ title, rows }: { title: string; rows: [string, number, number][] }) {
  return (
    <Panel title={title} padded={false}>
      <Table>
        <thead><tr><Th>Name</Th><Th className="text-right">Businesses</Th><Th className="text-right">With email</Th></tr></thead>
        <tbody>{rows.length ? rows.map(([k, b, e]) => (
          <Tr key={k}><Td className="max-w-[200px] truncate">{k}</Td><Td className="text-right tabular">{fmtNum(b)}</Td><Td className="text-right tabular">{fmtNum(e)}</Td></Tr>
        )) : <Tr><Td className="text-fg-3">No data yet.</Td></Tr>}</tbody>
      </Table>
    </Panel>
  );
}
