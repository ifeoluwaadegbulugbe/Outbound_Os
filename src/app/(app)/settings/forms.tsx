"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, Trash2, Copy } from "lucide-react";
import { Panel, Badge } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea, Checkbox } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { CATEGORIES, NIGERIAN_CITIES, CHANNEL_LABELS, MESSAGE_ANGLES, type Channel } from "@/server/domain/taxonomy";
import { effectiveDailyCap } from "@/server/domain/channels";
import { cn } from "@/lib/utils";
import * as A from "./actions";

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) { toast(r.message ?? "Saved"); after?.(); router.refresh(); } else toast.error(r.error ?? "Failed");
    });
  return { pending, run };
}

export function WorkspaceForm({ ws, canEdit }: { ws: { name: string; product_name: string; product_signup_url: string | null; verifiedProof: string[]; productFacts: string[] }; canEdit: boolean }) {
  const { pending, run } = useRun();
  const [name, setName] = useState(ws.name);
  const [product, setProduct] = useState(ws.product_name);
  const [url, setUrl] = useState(ws.product_signup_url ?? "");
  const [proof, setProof] = useState(ws.verifiedProof.join("\n"));
  const [facts, setFacts] = useState(ws.productFacts.join("\n"));
  return (
    <Panel title="Workspace">
      <fieldset disabled={!canEdit} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Workspace name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Product you sell"><Input value={product} onChange={(e) => setProduct(e.target.value)} /></Field>
        </div>
        <Field label="Signup URL" hint="Tracked links redirect here with UTM + ref code"><Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://app.getorbitcrm.com/signup" /></Field>
        <Field label="Product facts for the reply assistant" hint="One per line — the AI can only claim these">
          <Textarea value={facts} onChange={(e) => setFacts(e.target.value)} placeholder={"Orbit is free to start (no card needed).\nClients can book through a personal booking link."} />
        </Field>
        <Field label="Verified social proof" hint="One per line — anything else is blocked">
          <Textarea value={proof} onChange={(e) => setProof(e.target.value)} placeholder="e.g. used by 200+ Lagos businesses (only if true)" />
        </Field>
        {canEdit ? <Button variant="primary" loading={pending} onClick={() => run(() => A.updateWorkspaceAction({ name, productName: product, signupUrl: url, verifiedProof: proof, productFacts: facts }))}>Save</Button> : null}
      </fieldset>
    </Panel>
  );
}

export function PasswordForm() {
  const { pending, run } = useRun();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  return (
    <Panel title="Your password">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Current password"><Input type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>
        <Field label="New password" hint="10+ chars, letters & a number"><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" /></Field>
      </div>
      <Button className="mt-3" loading={pending} disabled={!cur || !next} onClick={() => run(() => A.changePasswordAction(cur, next), () => { setCur(""); setNext(""); })}>Change password</Button>
    </Panel>
  );
}

export function AddMemberForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin" | "viewer">("member");
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <Panel title="Add a teammate" description="Each person sends from their own real accounts — that's how you scale volume safely.">
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_140px_auto] sm:items-end">
        <Field label="Email"><Input value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value as typeof role)}><option value="member">Member</option><option value="admin">Admin</option><option value="viewer">Viewer</option></Select></Field>
        <Button variant="primary" loading={pending} onClick={() => start(async () => {
          const r = await A.addMemberAction({ email, name, role });
          if (r.ok) { setCreated({ email, password: r.password }); setEmail(""); setName(""); router.refresh(); } else toast.error(r.error);
        })}><Plus /> Add</Button>
      </div>
      {created ? (
        <div className="mt-3 rounded-md border border-warning/30 bg-warning-subtle p-3 text-[12.5px]">
          <p className="font-medium text-warning">Share this temporary password with {created.email} privately. It won&apos;t be shown again; they should change it after signing in.</p>
          <div className="mt-1.5 flex items-center gap-2"><code className="rounded bg-surface px-2 py-1 font-mono">{created.password}</code>
            <Button size="xs" onClick={async () => { await navigator.clipboard.writeText(created.password); toast("Copied"); }}><Copy /> Copy</Button></div>
        </div>
      ) : null}
    </Panel>
  );
}

export function MemberRole({ userId, role, disabled }: { userId: string; role: string; disabled: boolean }) {
  const { run } = useRun();
  return (
    <div className="flex items-center gap-1.5">
      <Select value={role} disabled={disabled} onChange={(e) => run(() => A.setMemberRoleAction(userId, e.target.value as "member"))} className="h-7 w-auto text-[12px]">
        {["owner", "admin", "member", "viewer"].map((r) => <option key={r} value={r}>{r}</option>)}
      </Select>
      {!disabled ? <ActionButton size="xs" variant="ghost" action={() => A.setMemberRoleAction(userId, "remove")} confirm={{ title: "Remove from workspace?", description: "They'll lose access immediately.", danger: true }}><Trash2 /></ActionButton> : null}
    </div>
  );
}

interface Sender { id: string | null; channel: Channel; label: string; daily_cap: number; warmup_enabled: boolean; warmup_start_cap: number; warmup_step: number; warmup_started_on: string; is_active: boolean; sent_today?: number }

export function SenderEditor({ sender, onDone }: { sender: Sender; onDone?: () => void }) {
  const { pending, run } = useRun();
  const [s, setS] = useState(sender);
  const cap = effectiveDailyCap({ ...s, warmup_started_on: s.warmup_started_on || new Date().toISOString() });
  return (
    <div className="grid gap-3 sm:grid-cols-6 sm:items-end">
      <Field label="Channel"><Select value={s.channel} onChange={(e) => setS({ ...s, channel: e.target.value as Channel })}>{(["instagram", "tiktok", "whatsapp", "email", "linkedin", "facebook"] as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}</Select></Field>
      <Field label="Account" className="sm:col-span-2"><Input value={s.label} onChange={(e) => setS({ ...s, label: e.target.value })} placeholder="@orbit.ng or +234…" /></Field>
      <Field label="Daily cap"><Input type="number" value={s.daily_cap} onChange={(e) => setS({ ...s, daily_cap: Number(e.target.value) })} /></Field>
      <Field label="Warm-up start / +weekly">
        <div className="flex gap-1"><Input type="number" value={s.warmup_start_cap} onChange={(e) => setS({ ...s, warmup_start_cap: Number(e.target.value) })} /><Input type="number" value={s.warmup_step} onChange={(e) => setS({ ...s, warmup_step: Number(e.target.value) })} /></div>
      </Field>
      <div className="flex flex-col gap-1.5 text-[12px]">
        <label className="flex items-center gap-1.5"><Checkbox checked={s.warmup_enabled} onChange={(e) => setS({ ...s, warmup_enabled: e.target.checked })} /> Warm-up</label>
        <label className="flex items-center gap-1.5"><Checkbox checked={s.is_active} onChange={(e) => setS({ ...s, is_active: e.target.checked })} /> Active</label>
      </div>
      <div className="flex items-center gap-3 sm:col-span-6">
        <Button size="sm" variant="primary" loading={pending} onClick={() => run(() => A.saveSenderAction({ id: s.id, channel: s.channel, label: s.label, dailyCap: s.daily_cap, warmupEnabled: s.warmup_enabled, warmupStartCap: s.warmup_start_cap, warmupStep: s.warmup_step, isActive: s.is_active }), onDone)}>
          {s.id ? "Save" : "Add account"}
        </Button>
        <span className="text-[12px] text-fg-3">Today&apos;s effective cap: <b className="text-fg">{cap}</b>{s.warmup_enabled && cap < s.daily_cap ? ` (warming up to ${s.daily_cap})` : ""}{s.sent_today != null ? ` · sent today ${s.sent_today}` : ""}</span>
        {s.daily_cap > 150 && (s.channel === "instagram" || s.channel === "tiktok") ? <Badge tone="warning">High for one {CHANNEL_LABELS[s.channel]} account — risk of restriction</Badge> : null}
      </div>
    </div>
  );
}

export function IcpForm({ config, canEdit }: { config: { targetCategories: string[]; targetCities: string[]; minFollowers: number; qualifyThreshold: number }; canEdit: boolean }) {
  const { pending, run } = useRun();
  const [cats, setCats] = useState(config.targetCategories);
  const [cities, setCities] = useState(config.targetCities);
  const [minF, setMinF] = useState(String(config.minFollowers));
  const [threshold, setThreshold] = useState(String(config.qualifyThreshold));
  const toggle = (arr: string[], v: string, set: (x: string[]) => void) => set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const chip = (active: boolean) => cn("h-7 rounded-md border px-2.5 text-[12.5px]", active ? "border-fg bg-fg text-bg" : "border-border bg-surface text-fg-2");
  return (
    <Panel title="Ideal customer profile" description="Drives the 0–100 ICP score. Every point is explained on each prospect.">
      <fieldset disabled={!canEdit} className="space-y-4">
        <Field label="Target categories (+20 points)"><div className="flex flex-wrap gap-1.5">{CATEGORIES.filter((c) => c.key !== "other_service").map((c) => <button key={c.key} type="button" className={chip(cats.includes(c.key))} onClick={() => toggle(cats, c.key, setCats)}>{c.label}</button>)}</div></Field>
        <Field label="Target cities (+15 points)"><div className="flex flex-wrap gap-1.5">{NIGERIAN_CITIES.map((c) => <button key={c.key} type="button" className={chip(cities.includes(c.name))} onClick={() => toggle(cities, c.name, setCities)}>{c.name}</button>)}</div></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Minimum followers (+3 points)"><Input type="number" value={minF} onChange={(e) => setMinF(e.target.value)} /></Field>
          <Field label="Qualify at ICP ≥" hint="Moves NEW → QUALIFIED"><Input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></Field>
        </div>
        <details className="text-[12.5px] text-fg-2">
          <summary className="cursor-pointer font-medium text-fg">How the score works</summary>
          <ul className="mt-2 list-disc space-y-1 pl-4">
            <li>Business fit 15 · Category fit 20 · Geography 15 · Operational fit 15 (takes bookings, multiple services, collects payments)</li>
            <li>Digital maturity 10 (Instagram/TikTok, followers, booking link) · Pain signals 15 (books via DMs/WhatsApp, manual deposits, no booking software)</li>
            <li>Activity 10 (recent posts, posting frequency) · Penalties: already uses booking software −10, large business −8, dormant 6+ months −10</li>
          </ul>
        </details>
        {canEdit ? <Button variant="primary" loading={pending} onClick={() => run(() => A.saveIcpAction({ targetCategories: cats, targetCities: cities, minFollowers: Number(minF) || 0, qualifyThreshold: Number(threshold) || 60 }))}>Save & re-score all</Button> : null}
      </fieldset>
    </Panel>
  );
}

export function GoalForm({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const { pending, run } = useRun();
  const [name, setName] = useState("Reach 30,000 qualified service businesses");
  const [metric, setMetric] = useState("qualified");
  const [target, setTarget] = useState("30000");
  const [start, setStart] = useState(new Date().toISOString().slice(0, 10));
  const [end, setEnd] = useState("2026-10-31");
  const [campaign, setCampaign] = useState("");
  const [geo, setGeo] = useState("");
  return (
    <Panel title="New goal">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Name" className="sm:col-span-3"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Metric"><Select value={metric} onChange={(e) => setMetric(e.target.value)}>{["discovered", "qualified", "contacted", "replied", "interested", "signed_up", "activated", "paid"].map((m) => <option key={m} value={m}>{m.replace("_", " ")}</option>)}</Select></Field>
        <Field label="Target"><Input type="number" value={target} onChange={(e) => setTarget(e.target.value)} /></Field>
        <Field label="Geography (city)"><Input value={geo} onChange={(e) => setGeo(e.target.value)} placeholder="Any" /></Field>
        <Field label="Start"><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
        <Field label="End"><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></Field>
        <Field label="Campaign"><Select value={campaign} onChange={(e) => setCampaign(e.target.value)}><option value="">All campaigns</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      </div>
      <Button className="mt-3" variant="primary" loading={pending} onClick={() => run(() => A.saveGoalAction({ name, metric, target: Number(target), startDate: start, endDate: end, campaignId: campaign || null, geography: geo || null }))}>Create goal</Button>
    </Panel>
  );
}

export function SequenceForm({ steps: initial, canEdit }: { steps: { day: number; angle: string; instructions?: string }[]; canEdit: boolean }) {
  const { pending, run } = useRun();
  const [steps, setSteps] = useState(initial.map((s) => ({ day: s.day, angle: s.angle, instructions: s.instructions ?? "" })));
  const angles = ["bump", "value", "final", ...MESSAGE_ANGLES.map((a) => a.key)];
  return (
    <Panel title="Follow-up sequence" description="Day 0 is the first message. Each step is drafted ~12h before it's due and waits for your approval. Any reply, conversion or opt-out stops the sequence.">
      <fieldset disabled={!canEdit} className="space-y-3">
        {steps.map((s, i) => (
          <div key={i} className="grid gap-2 sm:grid-cols-[90px_140px_1fr_auto] sm:items-end">
            <Field label={`Step ${i + 1} · day`}><Input type="number" value={s.day} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, day: Number(e.target.value) } : x)))} /></Field>
            <Field label="Angle"><Select value={s.angle} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, angle: e.target.value } : x)))}>{angles.map((a) => <option key={a}>{a}</option>)}</Select></Field>
            <Field label="Instructions"><Input value={s.instructions} onChange={(e) => setSteps(steps.map((x, j) => (j === i ? { ...x, instructions: e.target.value } : x)))} /></Field>
            <Button variant="ghost" size="sm" onClick={() => setSteps(steps.filter((_, j) => j !== i))} aria-label="Remove step"><Trash2 /></Button>
          </div>
        ))}
        {canEdit ? (
          <div className="flex gap-2">
            {steps.length < 6 ? <Button size="sm" onClick={() => setSteps([...steps, { day: (steps.at(-1)?.day ?? 0) + 7, angle: "bump", instructions: "" }])}><Plus /> Add step</Button> : null}
            <Button size="sm" variant="primary" loading={pending} onClick={() => run(() => A.saveSequenceAction(steps))}>Save sequence</Button>
          </div>
        ) : null}
      </fieldset>
    </Panel>
  );
}

export function DncForm() {
  const { pending, run } = useRun();
  const [kind, setKind] = useState("instagram");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("manual");
  const [note, setNote] = useState("");
  return (
    <Panel title="Add to suppression list" description="Matching prospects are suppressed now, and anyone with this identifier is skipped if discovered or imported later.">
      <div className="grid gap-3 sm:grid-cols-[130px_1fr_160px] sm:items-end">
        <Field label="Type"><Select value={kind} onChange={(e) => setKind(e.target.value)}><option value="instagram">Instagram handle</option><option value="tiktok">TikTok handle</option><option value="phone">Phone</option><option value="email">Email</option><option value="domain">Website domain</option></Select></Field>
        <Field label="Value"><Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="@handle, +234…, name@…" /></Field>
        <Field label="Reason"><Select value={reason} onChange={(e) => setReason(e.target.value)}><option value="manual">Manual</option><option value="opt_out">Opt-out</option><option value="customer">Customer</option><option value="competitor">Competitor</option><option value="invalid">Invalid</option><option value="closed">Closed</option><option value="inappropriate">Inappropriate</option></Select></Field>
        <Field label="Note" className="sm:col-span-3"><Input value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </div>
      <Button className="mt-3" variant="primary" loading={pending} disabled={!value.trim()} onClick={() => run(() => A.addDncAction(kind, value, reason, note), () => setValue(""))}>Add</Button>
    </Panel>
  );
}

export function DemoControls({ hasDemo }: { hasDemo: boolean }) {
  const router = useRouter();
  return (
    <Panel title="Demo data" description="1,000+ fictional Nigerian service businesses with simulated outreach history, so every screen has something to show. Handles end in .demo, phones are non-mobile, and nothing can be contacted.">
      {hasDemo ? (
        <ActionButton variant="danger" action={A.clearDemoAction} onDone={() => router.refresh()}
          confirm={{ title: "Remove all demo data?", description: "Deletes every demo prospect with its messages, conversations and events. Your real prospects are untouched.", danger: true }}>Remove demo data</ActionButton>
      ) : (
        <ActionButton variant="primary" action={A.loadDemoAction} onDone={() => router.refresh()}>Load demo data</ActionButton>
      )}
    </Panel>
  );
}

export function JobButtons({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  if (status === "failed") return <ActionButton size="xs" action={() => A.retryJobAction(id)} onDone={() => router.refresh()}>Retry</ActionButton>;
  if (status === "queued" || status === "running") return <ActionButton size="xs" variant="ghost" action={() => A.cancelJobAction(id)} onDone={() => router.refresh()}>Cancel</ActionButton>;
  return null;
}
