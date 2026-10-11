"use client";

import { useState, useTransition } from "react";
import { Sparkles, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel, Badge } from "@/components/ui/display";
import { Field, Input, Select, Textarea, Checkbox, FormError } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { CATEGORIES, NIGERIAN_CITIES, CHANNEL_LABELS, type Channel } from "@/server/domain/taxonomy";
import { CHANNEL_SPECS } from "@/server/domain/channels";
import type { FilterNode } from "@/server/domain/filters";
import { cn } from "@/lib/utils";
import { createCampaignAction, suggestTargetingAction } from "../actions";

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" onClick={onClick} aria-pressed={active}
      className={cn("inline-flex h-7 items-center gap-1 rounded-md border px-2.5 text-[12.5px] transition-colors", active ? "border-fg bg-fg text-bg" : "border-border bg-surface text-fg-2 hover:border-border-strong")}>
      {active ? <Check className="size-3" /> : null}{children}
    </button>
  );
}

export function CampaignForm({ sources }: { sources: { key: string; label: string; status: string }[] }) {
  const [pending, start] = useTransition();
  const [suggesting, startSuggest] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("Lagos Beauty Businesses");
  const [description, setDescription] = useState("Nail technicians, hair stylists, makeup artists and lash technicians in Lagos who take bookings in their DMs or on WhatsApp");
  const [categories, setCategories] = useState<string[]>([]);
  const [cities, setCities] = useState<string[]>([]);
  const [targeting, setTargeting] = useState<{ filter: FilterNode; summary: string; source: string } | null>(null);
  const [channels, setChannels] = useState<Channel[]>(["email", "instagram", "whatsapp"]);
  const [goal, setGoal] = useState("5000");
  const [endDate, setEndDate] = useState("2026-10-31");
  const [objective, setObjective] = useState("Get Orbit signups");
  const [offer, setOffer] = useState("Free Orbit account");
  const [tone, setTone] = useState("Casual, conversational, human, Nigerian — not corporate");
  const [instructions, setInstructions] = useState("Sound like a real person casually reaching out, the way you would talk. Short paragraphs, no em dashes. Mention the booking link only if they have one.");
  const [maxChars, setMaxChars] = useState("500");
  const [noEmojis, setNoEmojis] = useState(true);
  const [includeLink, setIncludeLink] = useState(false);
  const [addMatching, setAddMatching] = useState(true);
  const [minIcp, setMinIcp] = useState("60");
  const [discover, setDiscover] = useState(sources.find((s) => s.status === "available")?.key ?? "");
  const [discoverLimit, setDiscoverLimit] = useState("200");
  const [createGoal, setCreateGoal] = useState(true);

  const toggle = <T,>(arr: T[], v: T, set: (x: T[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);

  const suggest = () =>
    startSuggest(async () => {
      const r = await suggestTargetingAction(description);
      if (!r.ok) return toast.error(r.error);
      if (r.categories.length) setCategories(r.categories);
      if (r.cities.length) setCities(r.cities);
      setTargeting({ filter: r.filter, summary: r.summary, source: r.source });
      toast("Targeting suggested", { kind: "info", description: r.summary });
    });

  const submit = () =>
    start(async () => {
      setError(null);
      const r = await createCampaignAction({
        name, target_description: description, categories, cities, country: "NG", channels,
        prospect_goal: goal ? Number(goal) : null, objective: objective || null, offer: offer || null, tone: tone || null, instructions: instructions || null,
        constraints: { maxChars: maxChars ? Number(maxChars) : undefined, noEmojis, mentionBookingLinkOnlyIfPresent: true, includeLinkInitial: includeLink },
        start_date: new Date().toISOString().slice(0, 10), end_date: endDate || null, targeting: targeting?.filter ?? null,
        addMatching, minIcp: Number(minIcp) || 60, discovery: discover ? { adapter: discover, limit: Number(discoverLimit) || 100 } : null,
        createGoal, activate: true,
      });
      // On success the action redirects; we only get here on error.
      if (r && !r.ok) setError(r.error);
    });

  return (
    <div className="mx-auto grid max-w-5xl gap-4 lg:grid-cols-[1fr_300px]">
      <div className="space-y-4">
        <Panel title="1 · Who are you targeting?">
          <div className="space-y-3">
            <Field label="Campaign name" htmlFor="name"><Input id="name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
            <Field label="Describe your target" htmlFor="desc" hint="Plain English is fine">
              <Textarea id="desc" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-20" />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={suggest} loading={suggesting}><Sparkles /> Turn into targeting</Button>
              {targeting ? <span className="text-[12px] text-fg-3">{targeting.summary} <Badge className="ml-1">{targeting.source === "rules" ? "rules" : "AI"}</Badge></span> : null}
            </div>
            <Field label="Categories">
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.filter((c) => c.key !== "other_service").map((c) => (
                  <Chip key={c.key} active={categories.includes(c.key)} onClick={() => toggle(categories, c.key, setCategories)}>{c.label}</Chip>
                ))}
              </div>
            </Field>
            <Field label="Cities (Nigeria)">
              <div className="flex flex-wrap gap-1.5">
                {NIGERIAN_CITIES.map((c) => <Chip key={c.key} active={cities.includes(c.name)} onClick={() => toggle(cities, c.name, setCities)}>{c.name}</Chip>)}
              </div>
            </Field>
          </div>
        </Panel>

        <Panel title="2 · How will you reach them?">
          <div className="space-y-3">
            <Field label="Channels" hint="Order = preference">
              <div className="flex flex-wrap gap-1.5">
                {(["email", "instagram", "whatsapp", "tiktok"] as Channel[]).map((c) => (
                  <Chip key={c} active={channels.includes(c)} onClick={() => toggle(channels, c, setChannels)}>{CHANNEL_LABELS[c]}</Chip>
                ))}
              </div>
            </Field>
            <ul className="space-y-1 text-[12px] text-fg-3">
              {channels.map((c) => <li key={c}><span className="font-medium text-fg-2">{CHANNEL_LABELS[c]}:</span> {CHANNEL_SPECS[c].note}</li>)}
            </ul>
          </div>
        </Panel>

        <Panel title="3 · What should messages say?">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Objective"><Input value={objective} onChange={(e) => setObjective(e.target.value)} /></Field>
            <Field label="Offer"><Input value={offer} onChange={(e) => setOffer(e.target.value)} /></Field>
            <Field label="Tone" className="sm:col-span-2"><Input value={tone} onChange={(e) => setTone(e.target.value)} /></Field>
            <Field label="Instructions for the AI" className="sm:col-span-2" hint="Followed exactly"><Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} /></Field>
            <Field label="Max characters"><Input type="number" value={maxChars} onChange={(e) => setMaxChars(e.target.value)} /></Field>
            <div className="space-y-2 pt-5 text-[12.5px]">
              <label className="flex items-center gap-2"><Checkbox checked={noEmojis} onChange={(e) => setNoEmojis(e.target.checked)} /> No emojis</label>
              <label className="flex items-center gap-2"><Checkbox checked={includeLink} onChange={(e) => setIncludeLink(e.target.checked)} /> Include tracked link in first message</label>
            </div>
          </div>
          <p className="mt-2 text-[12px] text-fg-3">Four message variants (problem, curiosity, intro, feedback) are created and rotated automatically so you can see which works best.</p>
        </Panel>
      </div>

      <div className="space-y-4">
        <Panel title="4 · Goal">
          <div className="space-y-3">
            <Field label="Prospect goal"><Input type="number" value={goal} onChange={(e) => setGoal(e.target.value)} /></Field>
            <Field label="End date"><Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} /></Field>
            <label className="flex items-center gap-2 text-[12.5px]"><Checkbox checked={createGoal} onChange={(e) => setCreateGoal(e.target.checked)} /> Track as a goal on Overview</label>
          </div>
        </Panel>
        <Panel title="5 · Start finding prospects">
          <div className="space-y-3 text-[12.5px]">
            <label className="flex items-center gap-2"><Checkbox checked={addMatching} onChange={(e) => setAddMatching(e.target.checked)} /> Add existing prospects that match</label>
            {addMatching ? <Field label="Minimum ICP score"><Input type="number" value={minIcp} onChange={(e) => setMinIcp(e.target.value)} /></Field> : null}
            <Field label="Run discovery now">
              <Select value={discover} onChange={(e) => setDiscover(e.target.value)}>
                <option value="">Not now</option>
                {sources.map((s) => <option key={s.key} value={s.key}>{s.label}{s.status === "needs_setup" ? " (needs setup)" : s.status === "dev_only" ? " (dev only)" : ""}</option>)}
              </Select>
            </Field>
            {discover ? <Field label="Max prospects"><Input type="number" value={discoverLimit} onChange={(e) => setDiscoverLimit(e.target.value)} /></Field> : null}
          </div>
        </Panel>
        <FormError message={error} />
        <Button variant="primary" className="w-full" onClick={submit} loading={pending} disabled={!categories.length && !cities.length && !description}>Create campaign</Button>
        <p className="text-center text-[11.5px] text-fg-3">Nothing is ever sent without your approval.</p>
      </div>
    </div>
  );
}
