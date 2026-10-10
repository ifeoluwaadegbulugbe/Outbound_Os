"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Play, Pause, RotateCcw, Square, Copy } from "lucide-react";
import { Panel } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Input, Checkbox, Select } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import type { ActionResult } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { startCollectionAction, setCollectionPausedAction, retryDeadUnitsAction, stopCollectionAction } from "./actions";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>) => start(async () => {
    const r = await fn();
    if (r.ok) { toast(r.message ?? "Done"); router.refresh(); } else toast.error(r.error);
  });
  return { pending, run };
}

export function CollectionControls({ settings, countries, sources, canAdmin }: {
  settings: { active: boolean; paused: boolean; target: number; countries: string[]; sources: string[]; autoExpand: boolean; crawl: boolean };
  countries: { cc: string; name: string }[]; sources: { key: string; label: string; description: string; license: string }[]; canAdmin: boolean;
}) {
  const { pending, run } = useAct();
  const [cc, setCc] = useState<string[]>(settings.countries);
  const [src, setSrc] = useState<string[]>(settings.sources);
  const [target, setTarget] = useState(String(settings.target));
  const [auto, setAuto] = useState(settings.autoExpand);
  const [crawl, setCrawl] = useState(settings.crawl);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return (
    <Panel title="Collection controls" description="Runs in the background (the app's worker, or `npm run collect` for long unattended runs). All progress is stored, so it resumes after a restart.">
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded-md px-2 py-1 text-[12px] font-medium", !settings.active ? "bg-surface-3 text-fg-2" : settings.paused ? "bg-warning-subtle text-warning" : "bg-success-subtle text-success")}>
            {!settings.active ? "Not running" : settings.paused ? "Paused" : "Running"}
          </span>
          {settings.active ? (
            <>
              <Button size="sm" disabled={pending} onClick={() => run(() => setCollectionPausedAction(!settings.paused))}>{settings.paused ? <><Play /> Resume</> : <><Pause /> Pause</>}</Button>
              {canAdmin ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(stopCollectionAction)}><Square /> Stop</Button> : null}
            </>
          ) : null}
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(retryDeadUnitsAction)}><RotateCcw /> Retry failed work</Button>
        </div>
        {canAdmin ? (
          <>
            <Field label="Countries" hint="Nigeria first; auto-expand adds the next country when these are finished">
              <div className="flex flex-wrap gap-1.5">{countries.map((c) => (
                <button key={c.cc} type="button" onClick={() => toggle(cc, c.cc, setCc)} aria-pressed={cc.includes(c.cc)}
                  className={cn("h-7 rounded-md border px-2.5 text-[12.5px]", cc.includes(c.cc) ? "border-fg bg-fg text-bg" : "border-border text-fg-2")}>{c.name}</button>
              ))}</div>
            </Field>
            <Field label="Sources">
              <div className="space-y-2">{sources.map((s) => (
                <label key={s.key} className="flex items-start gap-2 text-[12.5px]">
                  <Checkbox className="mt-0.5" checked={src.includes(s.key)} onChange={() => toggle(src, s.key, setSrc)} />
                  <span><span className="font-medium">{s.label}</span> <span className="text-fg-3">· {s.description}</span><span className="block text-[11px] text-fg-3">{s.license}</span></span>
                </label>
              ))}</div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Target (unique businesses)"><Input type="number" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
              <label className="flex items-center gap-2 pt-5 text-[12.5px]"><Checkbox checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Auto-expand to more countries</label>
              <label className="flex items-center gap-2 pt-5 text-[12.5px]"><Checkbox checked={crawl} onChange={(e) => setCrawl(e.target.checked)} /> Crawl websites for emails</label>
            </div>
            <Button variant="primary" loading={pending} onClick={() => run(() => startCollectionAction({ countries: cc, sources: src, target: Number(target), autoExpand: auto, crawl }))}>
              <Play /> {settings.active ? "Update & queue" : "Start collection"}
            </Button>
          </>
        ) : null}
      </div>
    </Panel>
  );
}

export function ManualQueries({ groups }: { groups: { place: string; queries: string[] }[] }) {
  const [place, setPlace] = useState(groups[0]?.place ?? "");
  const g = groups.find((x) => x.place === place) ?? groups[0];
  if (!g) return null;
  return (
    <Panel title="Manual research queries" description="Search engines and Google Maps don't permit automated scraping, so these are for you to run by hand. Paste what you find into Discover → Quick capture or import a CSV; every record keeps its source.">
      <div className="mb-3 flex items-center gap-2">
        <Select value={place} onChange={(e) => setPlace(e.target.value)} className="h-8 w-auto text-[12.5px]">{groups.map((x) => <option key={x.place} value={x.place}>{x.place}</option>)}</Select>
        <Button size="xs" onClick={async () => { await navigator.clipboard.writeText(g.queries.join("\n")); toast(`Copied ${g.queries.length} queries`); }}><Copy /> Copy all</Button>
      </div>
      <ul className="grid gap-x-6 gap-y-1 text-[12.5px] text-fg-2 sm:grid-cols-2">{g.queries.map((q) => (
        <li key={q}><a className="hover:underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps/search/${encodeURIComponent(q)}`}>{q}</a></li>
      ))}</ul>
    </Panel>
  );
}
