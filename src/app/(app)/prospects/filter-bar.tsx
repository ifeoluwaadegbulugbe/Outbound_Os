"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { usePathname, useRouter } from "next/navigation";
import { Search, Sparkles, X, Bookmark } from "lucide-react";
import { Input, Select } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { CATEGORIES, PROSPECT_STATUSES, STATUS_LABELS, categoryLabel } from "@/server/domain/taxonomy";
import { describeFilter, type FilterNode } from "@/server/domain/filters";
import { FUNNEL_STAGES } from "@/server/domain/funnel";
import { decodeJson, encodeJson } from "@/lib/filter-codec";
import { parseFilterAction, saveViewAction } from "./actions";

const EMAIL_FILTERS = [
  { key: "sendable", label: "Email ready to send" },
  { key: "found", label: "Has an email" },
  { key: "verified", label: "Verified" },
  { key: "unknown", label: "Deliverability unknown" },
  { key: "catch_all", label: "Catch-all" },
  { key: "risky", label: "Risky" },
  { key: "invalid", label: "Invalid" },
  { key: "unverified", label: "Not checked yet" },
  { key: "needs_email", label: "Website not checked" },
  { key: "none", label: "No email found" },
];

export function ProspectFilterBar({
  params, campaigns, cities, canSave, base, countries = [], customCategories = [],
}: { params: Record<string, string>; campaigns: { id: string; name: string }[]; cities: string[]; canSave: boolean; base?: string; countries?: { code: string; name: string }[]; customCategories?: { key: string; label: string }[] }) {
  const router = useRouter();
  const currentPath = usePathname();
  const pathname = base ?? currentPath;
  const [q, setQ] = useState(params.q ?? "");
  const [nl, setNl] = useState("");
  const [pending, start] = useTransition();
  const [saving, setSaving] = useState(false);
  const [viewName, setViewName] = useState("");
  const first = useRef(true);

  const push = (updates: Record<string, string | null>) => {
    const sp = new URLSearchParams(params);
    for (const [k, v] of Object.entries(updates)) {
      if (v == null || v === "") sp.delete(k);
      else sp.set(k, v);
    }
    sp.delete("page");
    sp.delete("view");
    router.push(`${pathname}${sp.toString() ? `?${sp}` : ""}`, { scroll: false });
  };

  // Debounced search
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => push({ q: q.trim() || null }), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const filter: FilterNode | null = (() => {
    try {
      return params.f ? decodeJson<FilterNode>(params.f) : null;
    } catch {
      return null;
    }
  })();

  const runNl = () =>
    start(async () => {
      const r = await parseFilterAction(nl);
      if (!r.ok) return toast.error(r.error);
      if ("children" in r.filter && r.filter.children.length === 0) {
        return toast.error("Couldn't turn that into filters", r.unparsed.length ? `Didn't understand: ${r.unparsed.join(", ")}` : undefined);
      }
      push({ f: encodeJson(r.filter) });
      setNl("");
      toast(`Filtered: ${r.description}`, { kind: "info", description: r.unparsed.length ? `Ignored: ${r.unparsed.join(", ")}` : r.source === "rules" ? undefined : `Interpreted by ${r.source.replace("ai:", "AI · ")}` });
    });

  const chips: { label: string; clear: Record<string, null> }[] = [];
  if (params.status) chips.push({ label: `Status: ${params.status.split(",").map((s) => STATUS_LABELS[s as keyof typeof STATUS_LABELS] ?? s).join(", ")}`, clear: { status: null } });
  if (params.category) chips.push({ label: `Category: ${params.category.split(",").map(categoryLabel).join(", ")}`, clear: { category: null } });
  if (params.city) chips.push({ label: `City: ${params.city}`, clear: { city: null } });
  if (params.campaign) chips.push({ label: `Campaign: ${campaigns.find((c) => c.id === params.campaign)?.name ?? "…"}`, clear: { campaign: null } });
  if (params.stage) chips.push({ label: `Stage: ${FUNNEL_STAGES.find((s) => s.key === params.stage)?.label ?? params.stage}`, clear: { stage: null } });
  if (params.min_icp) chips.push({ label: `ICP ≥ ${params.min_icp}`, clear: { min_icp: null } });
  if (params.source) chips.push({ label: `Source: ${params.source}`, clear: { source: null } });
  if (params.email) chips.push({ label: `Email: ${EMAIL_FILTERS.find((e) => e.key === params.email)?.label ?? params.email}`, clear: { email: null } });
  if (params.social) chips.push({ label: { instagram: "Has Instagram", instagram_no_email: "Instagram, no email", tiktok: "Has TikTok" }[params.social] ?? params.social, clear: { social: null } });
  if (params.country) chips.push({ label: `Country: ${countries.find((c) => c.code === params.country)?.name ?? params.country}`, clear: { country: null } });
  if (filter) chips.push({ label: describeFilter(filter), clear: { f: null } });

  return (
    <div className="border-b border-border">
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <div className="relative min-w-[180px] flex-1 basis-[220px]">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-3" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, @handle, bio…" className="pl-8" aria-label="Search prospects" />
        </div>
        <Select aria-label="Email" value={params.email ?? ""} onChange={(e) => push({ email: e.target.value || null })} className="w-auto min-w-[130px]">
          <option value="">Any email</option>
          {EMAIL_FILTERS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
        </Select>
        <Select aria-label="Social profile" value={params.social ?? ""} onChange={(e) => push({ social: e.target.value || null })} className="w-auto min-w-[130px]">
          <option value="">Any social</option>
          <option value="instagram">Has Instagram</option>
          <option value="instagram_no_email">Instagram, no email</option>
          <option value="tiktok">Has TikTok</option>
        </Select>
        {countries.length > 1 ? (
          <Select aria-label="Country" value={params.country ?? ""} onChange={(e) => push({ country: e.target.value || null })} className="w-auto min-w-[110px]">
            <option value="">Any country</option>
            {countries.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
          </Select>
        ) : null}
        <Select aria-label="Status" value={params.status ?? ""} onChange={(e) => push({ status: e.target.value || null })} className="w-auto min-w-[120px]">
          <option value="">Any status</option>
          {PROSPECT_STATUSES.map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </Select>
        <Select aria-label="Category" value={params.category?.includes(",") ? "" : (params.category ?? "")} onChange={(e) => push({ category: e.target.value || null })} className="w-auto min-w-[130px]">
          <option value="">Any category</option>
          {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
          {customCategories.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </Select>
        <Select aria-label="City" value={params.city ?? ""} onChange={(e) => push({ city: e.target.value || null })} className="w-auto min-w-[110px]">
          <option value="">Any city</option>
          {cities.map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
        <Select aria-label="Minimum ICP score" value={params.min_icp ?? ""} onChange={(e) => push({ min_icp: e.target.value || null })} className="w-auto">
          <option value="">Any ICP</option>
          {[90, 80, 70, 60, 40].map((n) => <option key={n} value={n}>ICP ≥ {n}</option>)}
        </Select>
        {campaigns.length ? (
          <Select aria-label="Campaign" value={params.campaign ?? ""} onChange={(e) => push({ campaign: e.target.value || null })} className="w-auto min-w-[130px]">
            <option value="">Any campaign</option>
            {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-surface-2/40 px-3 py-2">
        <Sparkles className="size-3.5 shrink-0 text-accent" />
        <input
          value={nl}
          onChange={(e) => setNl(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && nl.trim() && runNl()}
          placeholder='Describe who you want — e.g. "nail techs in Lagos with more than 2k followers who take bookings, not contacted"'
          className="h-7 min-w-[200px] flex-1 bg-transparent text-[12.5px] outline-none placeholder:text-fg-3"
          aria-label="Describe a filter in plain English"
        />
        <Button size="xs" onClick={runNl} loading={pending} disabled={!nl.trim()}>Apply</Button>
        {chips.length > 0 ? (
          <>
            <span className="mx-1 hidden h-4 w-px bg-border sm:block" />
            {chips.map((c) => (
              <span key={c.label} className="inline-flex h-6 max-w-[360px] items-center gap-1 rounded-md border border-border bg-surface px-2 text-[11.5px] text-fg-2">
                <span className="truncate" title={c.label}>{c.label}</span>
                <button onClick={() => push(c.clear)} className="text-fg-3 hover:text-fg" aria-label={`Remove filter ${c.label}`}><X className="size-3" /></button>
              </span>
            ))}
            <button onClick={() => router.push(pathname)} className="text-[11.5px] text-fg-3 hover:text-fg">Clear all</button>
            {canSave ? (
              <Button size="xs" variant="ghost" onClick={() => setSaving(true)}><Bookmark /> Save view</Button>
            ) : null}
          </>
        ) : null}
      </div>
      <Dialog open={saving} onClose={() => setSaving(false)} title="Save view" description="Saved views appear as tabs for everyone in the workspace."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSaving(false)}>Cancel</Button>
            <Button variant="primary" disabled={!viewName.trim()} onClick={async () => {
              const { page: _page, view: _view, ...rest } = params;
              const r = await saveViewAction(viewName, rest);
              if (r.ok) { toast(r.message ?? "Saved"); setSaving(false); setViewName(""); router.refresh(); } else toast.error(r.error);
            }}>Save</Button>
          </>
        }>
        <Input autoFocus value={viewName} onChange={(e) => setViewName(e.target.value)} placeholder="e.g. High-value Lagos nail techs" aria-label="View name" />
      </Dialog>
    </div>
  );
}
