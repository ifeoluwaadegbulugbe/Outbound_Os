import Link from "next/link";
import { Download, Plus, Users } from "lucide-react";
import { requireUser, asUser, can } from "@/server/auth/session";
import { sql } from "@/server/db";
import { listProspects, parseListParams, DEFAULT_VIEWS } from "@/server/repos/prospects";
import { PageHeader, Panel, EmptyState } from "@/components/ui/display";
import { LinkButton } from "@/components/ui/button";
import { Pagination } from "@/components/ui/table";
import { ProspectFilterBar } from "./filter-bar";
import { ProspectTable } from "./prospect-table";
import { describeFilter } from "@/server/domain/filters";
import { cn, fmtNum, withParams } from "@/lib/utils";

export const metadata = { title: "Prospects" };

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser();
  const sp = await searchParams;
  const view = typeof sp.view === "string" ? sp.view : null;
  const builtIn = DEFAULT_VIEWS.find((v) => v.key === view);
  // A built-in view supplies default params; explicit URL params win.
  const effective = builtIn ? { ...builtIn.params, ...Object.fromEntries(Object.entries(sp).filter(([k]) => k !== "view")) } : sp;
  const params = parseListParams(effective as Record<string, string>);

  const data = await asUser(user, async (q) => {
    const [list, campaigns, saved, cities, countries, customCategories] = await Promise.all([
      listProspects(q, params),
      q.many<{ id: string; name: string }>(sql`select id, name from campaigns where status <> 'archived' order by created_at desc`),
      q.many<{ id: string; name: string; params: Record<string, string> }>(sql`select id, name, params from saved_views where page = 'prospects' order by created_at`),
      q.many<{ city: string; n: number }>(sql`select city, count(*)::int as n from prospects where city is not null and merged_into is null group by city order by n desc limit 20`),
      q.many<{ code: string; name: string }>(sql`
        select p.country as code, coalesce(max(l.country_name), p.country) as name from prospects p left join locations l on l.country_code = p.country
        where p.country is not null and p.merged_into is null group by p.country order by count(distinct p.id) desc`),
      q.many<{ key: string; label: string }>(sql`select key, label from categories where is_active order by label`),
    ]);
    return { ...list, campaigns, saved, cities, countries, customCategories };
  });

  const currentParams = Object.fromEntries(Object.entries(effective).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  const { view: _v, page: _p, ...selectable } = currentParams;
  const activeKey = view ?? (Object.keys(selectable).filter((k) => !["sort", "dir"].includes(k)).length === 0 ? "all" : null);

  return (
    <>
      <PageHeader
        title="Prospects"
        description={`${fmtNum(data.total)} ${data.total === 1 ? "prospect" : "prospects"}${params.filter ? ` · ${describeFilter(params.filter)}` : ""}`}
        actions={
          <>
            <a href={withParams("/api/export/prospects", currentParams, {})} className="inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium text-fg-2 hover:bg-surface-2 hover:text-fg">
              <Download className="size-3.5" /> Export CSV
            </a>
            <LinkButton href="/discover" size="sm" variant="primary"><Plus /> Find prospects</LinkButton>
          </>
        }
      >
        <nav className="-mb-3 flex gap-1 overflow-x-auto" aria-label="Saved views">
          {DEFAULT_VIEWS.map((v) => (
            <ViewTab key={v.key} href={v.key === "all" ? "/prospects" : `/prospects?view=${v.key}`} active={activeKey === v.key}>{v.name}</ViewTab>
          ))}
          {data.saved.map((v) => (
            <ViewTab key={v.id} href={withParams("/prospects", v.params, {})} active={false}>{v.name}</ViewTab>
          ))}
        </nav>
      </PageHeader>

      <div className="p-4 md:p-6">
        <Panel padded={false}>
          <ProspectFilterBar
            params={currentParams}
            campaigns={data.campaigns}
            cities={data.cities.map((c) => c.city)}
            countries={data.countries}
            customCategories={data.customCategories}
            canSave={can(user, "member")}
          />
          {data.total === 0 ? (
            <EmptyState
              icon={<Users />}
              title={Object.keys(selectable).length ? "No prospects match these filters" : "No prospects yet"}
              description={Object.keys(selectable).length ? "Try removing a filter or widening the score range." : "Run a discovery, capture profiles as you browse, or import a CSV."}
              action={Object.keys(selectable).length ? <LinkButton href="/prospects" size="sm">Clear filters</LinkButton> : <LinkButton href="/discover" variant="primary" size="sm">Find prospects</LinkButton>}
            />
          ) : (
            <>
              <ProspectTable rows={data.rows} total={data.total} params={currentParams} campaigns={data.campaigns} canEdit={can(user, "member")} sort={params.sort ?? "priority"} dir={params.dir ?? "desc"} />
              <Pagination page={params.page ?? 1} pageSize={50} total={data.total} base="/prospects" params={currentParams} />
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

function ViewTab({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} className={cn("whitespace-nowrap border-b-2 px-2 pb-2 text-[12.5px] transition-colors", active ? "border-fg font-medium text-fg" : "border-transparent text-fg-3 hover:text-fg")}>
      {children}
    </Link>
  );
}
