"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Plus, X } from "lucide-react";
import { Panel } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { CATEGORIES, MESSAGE_ANGLES, CHANNEL_LABELS, type Channel } from "@/server/domain/taxonomy";
import { createExperimentAction } from "./actions";

type Kind = "icp" | "message" | "channel" | "offer";

const OPTIONS: Record<Exclude<Kind, "offer">, { value: string; label: string }[]> = {
  icp: CATEGORIES.filter((c) => c.key !== "other_service").map((c) => ({ value: c.key, label: c.label })),
  message: MESSAGE_ANGLES.map((a) => ({ value: a.key, label: a.label })),
  channel: (["instagram", "whatsapp", "tiktok", "email"] as Channel[]).map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
};

export function NewExperiment({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<Kind>("message");
  const [name, setName] = useState("Problem-first vs curiosity");
  const [hypothesis, setHypothesis] = useState("");
  const [metric, setMetric] = useState("reply_rate");
  const [campaign, setCampaign] = useState("");
  const [variants, setVariants] = useState([{ name: "Problem-first", value: "problem_first" }, { name: "Curiosity", value: "curiosity" }]);
  const [pending, start] = useTransition();

  const onKind = (k: Kind) => {
    setKind(k);
    if (k === "offer") setVariants([{ name: "Try Orbit free", value: "Try Orbit free" }, { name: "I'd love your feedback", value: "I'd love your feedback" }]);
    else setVariants(OPTIONS[k].slice(0, 2).map((o) => ({ name: o.label, value: o.value })));
  };

  if (!open) return <Button variant="primary" size="sm" onClick={() => setOpen(true)}><Plus /> New experiment</Button>;
  return (
    <Panel title="New experiment" actions={<Button size="xs" variant="ghost" onClick={() => setOpen(false)}><X /></Button>}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label="Type">
          <Select value={kind} onChange={(e) => onKind(e.target.value as Kind)}>
            <option value="icp">ICP — who to target</option><option value="message">Message — what to say</option>
            <option value="channel">Channel — where</option><option value="offer">Offer — what to offer</option>
          </Select>
        </Field>
        <Field label="Hypothesis" className="sm:col-span-2"><Input value={hypothesis} onChange={(e) => setHypothesis(e.target.value)} placeholder="Naming a specific friction gets more replies than a question" /></Field>
        <Field label="Primary metric">
          <Select value={metric} onChange={(e) => setMetric(e.target.value)}>
            <option value="reply_rate">Reply rate</option><option value="interest_rate">Interest rate</option><option value="signup_rate">Signup rate</option>
            <option value="activation_rate">Activation rate</option><option value="paid_rate">Paid rate</option>
          </Select>
        </Field>
        <Field label="Campaign"><Select value={campaign} onChange={(e) => setCampaign(e.target.value)}><option value="">All</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
      </div>
      <div className="mt-4 space-y-2">
        {variants.map((v, i) => (
          <div key={i} className="flex items-end gap-2">
            <span className="mb-2 w-5 text-[13px] font-semibold">{String.fromCharCode(65 + i)}</span>
            {kind === "offer" ? (
              <Field label="Offer" className="flex-1"><Input value={v.value} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { name: e.target.value, value: e.target.value } : x)))} /></Field>
            ) : (
              <Field label="Variant" className="flex-1">
                <Select value={v.value} onChange={(e) => setVariants(variants.map((x, j) => (j === i ? { value: e.target.value, name: OPTIONS[kind as Exclude<Kind, "offer">].find((o) => o.value === e.target.value)?.label ?? e.target.value } : x)))}>
                  {OPTIONS[kind as Exclude<Kind, "offer">].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </Select>
              </Field>
            )}
            {variants.length > 2 ? <Button variant="ghost" size="sm" onClick={() => setVariants(variants.filter((_, j) => j !== i))} aria-label="Remove variant"><X /></Button> : null}
          </div>
        ))}
        {variants.length < 4 ? <Button size="xs" variant="ghost" onClick={() => setVariants([...variants, { ...variants[0] }])}><Plus /> Add variant</Button> : null}
      </div>
      {kind === "offer" ? <p className="mt-2 text-[12px] text-fg-3">Offer experiments use explicit assignments: set the campaign&apos;s offer per batch, or assign prospects to variants.</p> : null}
      <Button className="mt-4" variant="primary" loading={pending} onClick={() => start(async () => {
        const r = await createExperimentAction({ name, hypothesis: hypothesis || null, kind, primaryMetric: metric as "reply_rate", campaignId: campaign || null, variants });
        if (r.ok) { toast(r.message ?? "Started"); setOpen(false); router.refresh(); } else toast.error(r.error);
      })}>Start experiment</Button>
    </Panel>
  );
}
