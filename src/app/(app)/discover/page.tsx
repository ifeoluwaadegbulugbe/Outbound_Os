import Link from "next/link";
import { Search } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { ADAPTERS } from "@/server/adapters/registry";
import { listProspects } from "@/server/repos/prospects";
import { parseNaturalLanguage, describeFilter } from "@/server/domain/filters";
import { PageHeader, Panel, EmptyState, Badge } from "@/components/ui/display";
import { JobProgress } from "@/components/job-progress";
import { ProspectTable } from "../prospects/prospect-table";
import { DiscoverySearch, DiscoveryLauncher } from "./launcher";
import { RunControls } from "./run-controls";
import { CATEGORIES } from "@/server/domain/taxonomy";
import { getEmailSettings } from "@/server/email/policy";
import { CaptureForm } from "./capture";
import { ImportWizard } from "./import-wizard";
import { DuplicateList, type DuplicatePair } from "./duplicates";
import { cn, fmtNum, timeAgo } from "@/lib/utils";
import { appUrl } from "@/server/services/links";

export const metadata = { title: "Discover" };

const TABS = [
  { key: "search", label: "Search" },
  { key: "capture", label: "Quick capture" },
  { key: "import", label: "Import CSV" },
  { key: "duplicates", label: "Possible duplicates" },
  { key: "runs", label: "Runs" },
];

export default async function DiscoverPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "search";
  const query = sp.q?.trim() ?? "";
  const parsed = query ? parseNaturalLanguage(query) : null;

  const data = await asUser(user, async (q) => {
    const campaigns = await q.many<{ id: string; name: string }>(sql`select id, name from campaigns where status in ('active','draft','paused') order by created_at desc`);
    const integrations = await q.many<{ key: string; status: string }>(sql`select key, status from integrations`);
    const dupCount = await q.value<number>(sql`select count(*)::int from possible_duplicates where status = 'pending'`);
    const results = parsed ? await listProspects(q, { filter: parsed.filter, sort: "priority", dir: "desc", page: Number(sp.page ?? 1) }) : null;
    const runs = tab === "runs" || tab === "search"
      ? await q.many<{ id: string; adapter: string; status: string; found: number; created: number; merged: number; duplicates_flagged: number; skipped: number; created_at: Date; job_id: string | null; error: string | null; campaign: string | null; emails_found: number; target: number | null; units_done: number; params: { cities?: string[]; categories?: string[] } }>(sql`
          select r.id, r.adapter, r.status, r.found, r.created, r.merged, r.duplicates_flagged, r.skipped, r.created_at, r.job_id, r.error, c.name as campaign,
            r.emails_found, r.target, coalesce(jsonb_array_length(r.checkpoint->'done'), 0)::int as units_done, r.params
          from discovery_runs r left join campaigns c on c.id = r.campaign_id order by r.created_at desc limit ${tab === "runs" ? 30 : 3}`)
      : [];
    const imports = tab === "import" || tab === "runs"
      ? await q.many<{ id: string; filename: string | null; status: string; total: number; created: number; merged: number; duplicates_flagged: number; skipped: number; created_at: Date; job_id: string | null }>(sql`
          select id, filename, status, total, created, merged, duplicates_flagged, skipped, created_at, job_id from import_batches order by created_at desc limit 10`)
      : [];
    const dups = tab === "duplicates"
      ? await q.many<DuplicatePair>(sql`
          select d.id, d.confidence, d.reasons,
            json_build_object('id', a.id, 'business_name', a.business_name, 'city', a.city, 'category', a.category, 'instagram_handle', a.instagram_handle, 'phone', a.phone, 'source', a.source, 'icp_score', a.icp_score, 'status', a.status, 'contact_count', a.contact_count) as a,
            json_build_object('id', b.id, 'business_name', b.business_name, 'city', b.city, 'category', b.category, 'instagram_handle', b.instagram_handle, 'phone', b.phone, 'source', b.source, 'icp_score', b.icp_score, 'status', b.status, 'contact_count', b.contact_count) as b
          from possible_duplicates d join prospects a on a.id = d.prospect_a join prospects b on b.id = d.prospect_b
          where d.status = 'pending' order by d.confidence desc limit 50`)
      : [];
    const locations = await q.many<{ key: string; city: string; country_code: string; country_name: string }>(sql`
      select key, city, country_code, country_name from locations where is_active order by country_name, is_builtin desc, city`);
    const custom = await q.many<{ key: string; label: string }>(sql`select key, label from categories where is_active order by label`);
    const settings = await getEmailSettings(q, user.workspaceId);
    // What each source has actually contributed (real counts, not estimates).
    const contributions = tab === "runs"
      ? await q.many<{ source: string; total: number; with_email: number; verified: number; with_website: number; countries: number }>(sql`
          select source, count(*)::int as total, count(*) filter (where email is not null)::int as with_email,
            count(*) filter (where email_status = 'verified')::int as verified, count(*) filter (where website is not null)::int as with_website,
            count(distinct country)::int as countries
          from prospects where not is_demo group by source order by total desc`)
      : [];
    return { campaigns, integrations, dupCount, results, runs, imports, dups, locations, custom, defaultCountry: settings.defaultCountry, contributions };
  });

  const status = new Map(data.integrations.map((i) => [i.key, i.status]));
  const sources = Object.values(ADAPTERS).map((a) => ({
    key: a.info.key, label: a.info.label, description: a.info.description, mode: a.info.mode,
    status: a.info.key === "instagram_graph" ? (status.get("instagram_graph") === "connected" ? "available" : "needs_setup") : a.info.status,
    attribution: a.info.attribution ?? null,
  }));
  const canEdit = can(user, "member");
  const active = data.runs.filter((r) => r.status === "running" || r.status === "queued");

  return (
    <>
      <PageHeader title="Discover" description="Find service businesses from permitted sources, capture profiles as you browse, or import your own lists.">
        <nav className="-mb-3 flex gap-1 overflow-x-auto" aria-label="Discover sections">
          {TABS.map((t) => (
            <Link key={t.key} href={`/discover${t.key === "search" ? "" : `?tab=${t.key}`}`}
              className={cn("flex items-center gap-1.5 whitespace-nowrap border-b-2 px-2 pb-2 text-[12.5px]", tab === t.key ? "border-fg font-medium text-fg" : "border-transparent text-fg-3 hover:text-fg")}>
              {t.label}
              {t.key === "duplicates" && data.dupCount ? <span className="rounded bg-warning-subtle px-1.5 text-[11px] leading-[18px] text-warning">{data.dupCount}</span> : null}
            </Link>
          ))}
        </nav>
      </PageHeader>

      <div className="space-y-4 p-4 md:p-6">
        {active.map((r) => (
          <Panel key={r.id}><JobProgress jobId={r.job_id} title={`Discovering via ${r.adapter.replace(/_/g, " ")}${r.campaign ? ` for ${r.campaign}` : ""}`} doneHref={`/prospects?sort=discovered`} />
            {canEdit ? <div className="mt-2 flex justify-end"><RunControls runId={r.id} status={r.status} /></div> : null}
          </Panel>
        ))}

        {tab === "search" ? (
          <>
            <DiscoverySearch initial={query} />
            {parsed ? (
              <Panel padded={false} title={`${fmtNum(data.results?.total ?? 0)} prospects in your database`} description={describeFilter(parsed.filter) + (parsed.unparsed.length ? ` · ignored: ${parsed.unparsed.join(", ")}` : "")}>
                {data.results && data.results.total > 0 ? (
                  <ProspectTable rows={data.results.rows} total={data.results.total} params={{ f: Buffer.from(JSON.stringify(parsed.filter)).toString("base64url") }} campaigns={data.campaigns} canEdit={canEdit} sort="priority" dir="desc" />
                ) : (
                  <EmptyState icon={<Search />} title="No matches yet" description="Run a discovery below to find more businesses like this." />
                )}
              </Panel>
            ) : null}
            {canEdit ? <DiscoveryLauncher sources={sources} campaigns={data.campaigns} defaultCampaign={sp.campaign ?? null} seed={parsed?.filter ?? null}
              locations={data.locations} defaultCountry={data.defaultCountry}
              categories={[...CATEGORIES.map((c) => ({ key: c.key as string, label: c.label as string, custom: false })), ...data.custom.filter((c) => !CATEGORIES.some((b) => b.key === c.key)).map((c) => ({ ...c, custom: true }))]} /> : null}
          </>
        ) : null}

        {tab === "capture" ? (
          <CaptureForm campaigns={data.campaigns} bookmarkletBase={appUrl()} initial={{ url: sp.url ?? "", text: sp.text ?? "", name: sp.title ?? "" }} />
        ) : null}

        {tab === "import" ? (
          <>
            <ImportWizard campaigns={data.campaigns} />
            {data.imports.length ? (
              <Panel title="Recent imports">
                <ul className="space-y-3">{data.imports.map((i) => (
                  <li key={i.id}>
                    {i.status === "queued" || i.status === "running" ? <JobProgress jobId={i.job_id} title={`Importing ${i.filename ?? "CSV"}`} /> : (
                      <div className="text-[12.5px]"><span className="font-medium">{i.filename ?? "CSV"}</span> <Badge tone={i.status === "succeeded" ? "success" : "neutral"}>{i.status}</Badge> <span className="text-fg-3">· {fmtNum(i.total)} rows · {fmtNum(i.created)} new · {fmtNum(i.merged)} matched · {fmtNum(i.duplicates_flagged)} flagged · {fmtNum(i.skipped)} skipped · {timeAgo(i.created_at)}</span></div>
                    )}
                  </li>
                ))}</ul>
              </Panel>
            ) : null}
          </>
        ) : null}

        {tab === "duplicates" ? <DuplicateList pairs={data.dups} canEdit={canEdit} /> : null}

        {tab === "runs" && data.contributions.length ? (
          <Panel padded={false} title="What each source has contributed" description="Counts from your database. Email coverage depends on businesses publishing an address on their own website.">
            <div className="overflow-x-auto"><table className="w-full text-[12.5px]">
              <thead className="text-left text-fg-3"><tr className="border-b border-border">
                {["Source", "Businesses", "With website", "With email", "Verified email", "Countries"].map((h) => <th key={h} className="px-4 py-2 font-medium">{h}</th>)}
              </tr></thead>
              <tbody>{data.contributions.map((c) => (
                <tr key={c.source} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium">{c.source.replace(/_/g, " ")}</td>
                  <td className="px-4 py-2 tabular-nums">{fmtNum(c.total)}</td>
                  <td className="px-4 py-2 tabular-nums">{fmtNum(c.with_website)}</td>
                  <td className="px-4 py-2 tabular-nums">{fmtNum(c.with_email)} <span className="text-fg-3">({c.total ? Math.round((c.with_email / c.total) * 100) : 0}%)</span></td>
                  <td className="px-4 py-2 tabular-nums">{fmtNum(c.verified)}</td>
                  <td className="px-4 py-2 tabular-nums">{c.countries}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Panel>
        ) : null}

        {tab === "runs" ? (
          <Panel padded={false} title="Discovery runs">
            {data.runs.length === 0 ? <EmptyState title="No runs yet" description="Start one from the Search tab." /> : (
              <ul className="divide-y divide-border">{data.runs.map((r) => (
                <li key={r.id} className="px-4 py-3 text-[12.5px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{r.adapter.replace(/_/g, " ")}</span>
                    <Badge tone={r.status === "succeeded" ? "success" : r.status === "failed" ? "danger" : r.status === "running" ? "info" : r.status === "paused" ? "warning" : "neutral"}>{r.status}</Badge>
                    {r.campaign ? <span className="text-fg-3">· {r.campaign}</span> : null}
                    <span className="ml-auto text-fg-3">{timeAgo(r.created_at)}</span>
                    {canEdit ? <RunControls runId={r.id} status={r.status} /> : null}
                  </div>
                  <p className="mt-0.5 text-fg-3">{fmtNum(r.found)}{r.target ? ` / ${fmtNum(r.target)}` : ""} found · {fmtNum(r.created)} new · {fmtNum(r.merged)} matched existing · {fmtNum(r.duplicates_flagged)} possible duplicates · {fmtNum(r.skipped)} skipped/suppressed · {fmtNum(r.emails_found)} with email from source</p>
                  {r.adapter === "osm_overpass" && r.status !== "succeeded" && r.params?.cities && r.params?.categories ? (
                    <p className="mt-0.5 text-fg-3">Checkpoint: {r.units_done} of {r.params.cities.length * r.params.categories.length} search steps complete{r.status === "paused" || r.status === "failed" ? ". Resume continues from here." : ""}</p>
                  ) : null}
                  {r.error ? <p className="mt-0.5 text-danger">{r.error}</p> : null}
                </li>
              ))}</ul>
            )}
          </Panel>
        ) : null}
      </div>
    </>
  );
}
