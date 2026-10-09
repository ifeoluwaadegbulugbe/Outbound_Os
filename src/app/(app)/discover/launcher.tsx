"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Search, Play, Hash, ShieldCheck } from "lucide-react";
import { Panel, Badge } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Checkbox } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { suggestHashtags } from "@/server/domain/taxonomy";
import { isGroup, type FilterNode } from "@/server/domain/filters";
import { cn } from "@/lib/utils";
import { startDiscoveryAction } from "./actions";

export function DiscoverySearch({ initial }: { initial: string }) {
  const router = useRouter();
  const [q, setQ] = useState(initial);
  return (
    <form className="relative" onSubmit={(e) => { e.preventDefault(); router.push(q.trim() ? `/discover?q=${encodeURIComponent(q.trim())}` : "/discover"); }}>
      <Search className="pointer-events-none absolute left-4 top-1/2 size-4 -translate-y-1/2 text-fg-3" />
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder='Try "Lagos nail technicians with booking links" or "lash techs in Abuja, active, not contacted"'
        className="h-12 w-full rounded-xl border border-border bg-surface pl-11 pr-28 text-[14.5px] shadow-sm outline-none transition-colors placeholder:text-fg-3 focus:border-accent focus:ring-4 focus:ring-[var(--ring)]/30"
        aria-label="Search for prospects" />
      <Button type="submit" variant="primary" size="sm" className="absolute right-2 top-1/2 -translate-y-1/2">Search</Button>
    </form>
  );
}

interface SourceInfo { key: string; label: string; description: string; mode: string; status: string; attribution: string | null }

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn("h-7 rounded-md border px-2.5 text-[12.5px]", active ? "border-fg bg-fg text-bg" : "border-border bg-surface text-fg-2 hover:border-border-strong")}>{children}</button>
  );
}

export interface LocationOption { key: string; city: string; country_code: string; country_name: string }
export interface CategoryOption { key: string; label: string; custom: boolean }

export function DiscoveryLauncher({ sources, campaigns, defaultCampaign, seed, locations, categories, defaultCountry }: {
  sources: SourceInfo[]; campaigns: { id: string; name: string }[]; defaultCampaign: string | null; seed: FilterNode | null;
  locations: LocationOption[]; categories: CategoryOption[]; defaultCountry: string;
}) {
  const router = useRouter();
  const seedCats: string[] = [];
  const seedCities: string[] = [];
  if (seed && isGroup(seed)) {
    for (const c of seed.children) {
      if (!("field" in c)) continue;
      const vals = Array.isArray(c.value) ? c.value : c.value != null ? [String(c.value)] : [];
      if (c.field === "category") seedCats.push(...vals);
      if (c.field === "city") seedCities.push(...locations.filter((x) => vals.includes(x.city)).map((x) => x.key));
    }
  }
  const [source, setSource] = useState(sources.find((s) => s.status === "available")?.key ?? sources[0]?.key ?? "");
  const [cats, setCats] = useState<string[]>(seedCats.length ? seedCats : ["nail_technician", "hair_stylist"]);
  const firstLoc = locations.find((l) => l.country_code === defaultCountry) ?? locations[0];
  const [cities, setCities] = useState<string[]>(seedCities.length ? seedCities : firstLoc ? [firstLoc.key] : []);
  const [country, setCountry] = useState(firstLoc?.country_code ?? defaultCountry);
  const [findEmails, setFindEmails] = useState(true);
  const countries = [...new Map(locations.map((l) => [l.country_code, l.country_name])).entries()];
  const inCountry = locations.filter((l) => l.country_code === country);
  const selectedElsewhere = cities.filter((k) => !inCountry.some((l) => l.key === k)).length;
  const [limit, setLimit] = useState("200");
  const [campaign, setCampaign] = useState(defaultCampaign ?? "");
  const [hashtags, setHashtags] = useState("");
  const [seeds, setSeeds] = useState("");
  const [pending, start] = useTransition();
  const sel = sources.find((s) => s.key === source);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const cityName = (k: string) => locations.find((l) => l.key === k)?.city.toLowerCase().replace(/s+/g, "") ?? k;
  const suggested = cats.flatMap((c) => cities.flatMap((ci) => suggestHashtags(c, cityName(ci)))).slice(0, 8);
  const units = cats.length * cities.length;

  return (
    <Panel title="Find more businesses" description="Runs in the background through official or openly-licensed sources. Results are deduplicated and scored automatically.">
      <div className="grid gap-5 lg:grid-cols-[260px_1fr]">
        <div className="space-y-2">
          {sources.map((s) => (
            <button key={s.key} type="button" onClick={() => setSource(s.key)} disabled={s.status === "disabled"}
              className={cn("w-full rounded-lg border p-3 text-left transition-colors disabled:opacity-50", source === s.key ? "border-accent bg-accent-subtle/50" : "border-border hover:border-border-strong")}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-[13px] font-medium">{s.label}</span>
                <Badge tone={s.status === "available" ? "success" : s.status === "needs_setup" ? "warning" : s.status === "dev_only" ? "info" : "neutral"}>
                  {s.status === "available" ? "Ready" : s.status === "needs_setup" ? "Needs setup" : s.status === "dev_only" ? "Dev only" : "Off"}
                </Badge>
              </div>
              <p className="mt-1 text-[11.5px] leading-snug text-fg-3">{s.description}</p>
            </button>
          ))}
          <p className="flex gap-1.5 pt-1 text-[11.5px] text-fg-3"><ShieldCheck className="size-3.5 shrink-0" /> TikTok, LinkedIn and Google Maps aren&apos;t listed because they offer no permitted way to discover businesses automatically.</p>
        </div>
        <div className="space-y-4">
          <Field label="Categories">
            <div className="flex flex-wrap gap-1.5">{categories.filter((c) => c.key !== "other_service").map((c) => <Chip key={c.key} active={cats.includes(c.key)} onClick={() => toggle(cats, c.key, setCats)}>{c.label}{c.custom ? " *" : ""}</Chip>)}</div>
          </Field>
          <Field label="Locations" hint={<a href="/settings/taxonomy#locations" className="underline">Add a city</a>}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <Select value={country} onChange={(e) => setCountry(e.target.value)} className="h-8 w-auto text-[12.5px]" aria-label="Country">
                {countries.map(([cc, name]) => <option key={cc} value={cc}>{name}</option>)}
              </Select>
              <button type="button" className="text-[12px] text-fg-3 underline" onClick={() => setCities([...new Set([...cities, ...inCountry.map((l) => l.key)])])}>Select all in country</button>
              {selectedElsewhere ? <span className="text-[12px] text-fg-3">+{selectedElsewhere} selected in other countries</span> : null}
            </div>
            <div className="flex flex-wrap gap-1.5">{inCountry.map((c) => <Chip key={c.key} active={cities.includes(c.key)} onClick={() => toggle(cities, c.key, setCities)}>{c.city}</Chip>)}</div>
          </Field>
          {source === "instagram_graph" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={<span className="inline-flex items-center gap-1"><Hash className="size-3" /> Hashtags</span>} hint="Max 30 unique / 7 days">
                <Input value={hashtags} onChange={(e) => setHashtags(e.target.value)} placeholder={suggested.slice(0, 3).map((h) => `#${h}`).join(" ")} />
              </Field>
              <Field label="Seed accounts (optional)" hint="Starting points for the snowball">
                <Input value={seeds} onChange={(e) => setSeeds(e.target.value)} placeholder="@lagosnailacademy @..." />
              </Field>
              <p className="text-[11.5px] text-fg-3 sm:col-span-2">Leave hashtags empty to use: {suggested.map((h) => `#${h}`).join(", ")}</p>
            </div>
          ) : null}
          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Max prospects" hint={`${units} search step${units === 1 ? "" : "s"}`}><Input type="number" min={1} max={50000} value={limit} onChange={(e) => setLimit(e.target.value)} /></Field>
            <Field label="Add to campaign" className="sm:col-span-2">
              <Select value={campaign} onChange={(e) => setCampaign(e.target.value)}>
                <option value="">None</option>
                {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
          </div>
          {source !== "instagram_graph" ? (
            <label className="flex items-start gap-2 text-[12.5px] text-fg-2"><Checkbox className="mt-0.5" checked={findEmails} onChange={(e) => setFindEmails(e.target.checked)} /> Then look for public emails on each business&apos;s website (respects robots.txt, never guesses addresses)</label>
          ) : null}
          {sel?.attribution ? <p className="text-[11.5px] text-fg-3">Data: {sel.attribution}</p> : null}
          {sel?.status === "needs_setup" ? (
            <p className="rounded-md bg-warning-subtle px-3 py-2 text-[12.5px] text-warning">Connect this source first in <a href="/integrations" className="underline">Integrations</a>.</p>
          ) : null}
          <Button variant="primary" loading={pending} disabled={sel?.status === "needs_setup" || sel?.status === "disabled"} onClick={() => start(async () => {
            const r = await startDiscoveryAction({ adapter: source, categories: cats, cities, limit: Number(limit) || 100, campaignId: campaign || null, hashtags, seedHandles: seeds, findEmails: findEmails && source !== "instagram_graph" });
            if (r.ok) { toast(r.message ?? "Started"); router.refresh(); } else toast.error(r.error);
          })}><Play /> Start discovery</Button>
        </div>
      </div>
    </Panel>
  );
}
