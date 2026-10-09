"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Check, X, RefreshCw, AlertTriangle, ShieldX, Sparkles, CheckCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, ScoreBadge, Kbd } from "@/components/ui/display";
import { Checkbox, Select, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { CHANNEL_SPECS } from "@/server/domain/channels";
import { categoryLabel, MESSAGE_ANGLES, type Channel } from "@/server/domain/taxonomy";
import type { ValidationResult } from "@/server/domain/validator";
import { cn, fmtNum } from "@/lib/utils";
import { approveAction, approveAllReadyAction, editMessageAction, regenerateAction, rejectAction } from "./actions";

export interface ReviewItem {
  id: string;
  prospect_id: string;
  campaign_id: string | null;
  campaign_name: string | null;
  channel: Channel;
  kind: string;
  step: number;
  angle: string | null;
  subject: string | null;
  body: string;
  status: string;
  validation: ValidationResult;
  generator: string;
  edited: boolean;
  business_name: string;
  first_name: string | null;
  category: string | null;
  city: string | null;
  icp_score: number | null;
  instagram_handle: string | null;
  tiktok_handle: string | null;
  is_demo: boolean;
  bio: string | null;
}

function generatorLabel(g: string) {
  if (g.startsWith("ai:")) return `AI · ${g.slice(3).split("/")[0]}`;
  if (g === "template") return "Template";
  return g === "human" ? "Written by you" : g;
}

export function ReviewList({ items, canEdit, batchId, totalReady, totalBlocked }: { items: ReviewItem[]; canEdit: boolean; batchId: string | null; totalReady?: number; totalBlocked?: number }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState(0);
  const [pending, start] = useTransition();
  const ready = items.filter((i) => i.status === "needs_review");
  const refs = useRef<(HTMLDivElement | null)[]>([]);

  const act = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) toast(r.message ?? "Done");
      else toast.error(r.error ?? "Failed");
      setSelected(new Set());
      router.refresh();
    });

  // Keyboard: j/k move · a approve · x reject · e edit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || e.metaKey || e.ctrlKey) return;
      const item = items[focus];
      if (e.key === "j") setFocus((f) => Math.min(items.length - 1, f + 1));
      else if (e.key === "k") setFocus((f) => Math.max(0, f - 1));
      else if (e.key === "a" && item && canEdit && item.status === "needs_review") act(() => approveAction([item.id]));
      else if (e.key === "x" && item && canEdit) act(() => rejectAction([item.id]));
      else if (e.key === "e" && item) {
        e.preventDefault();
        refs.current[focus]?.querySelector("textarea")?.focus();
      } else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, focus, canEdit]);

  useEffect(() => {
    refs.current[focus]?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focus]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px]">
          <span className="font-semibold">{fmtNum(totalReady ?? ready.length)} messages ready for review</span>
          {(totalBlocked ?? items.length - ready.length) ? <span className="text-fg-3"> · {fmtNum(totalBlocked ?? items.length - ready.length)} blocked by the safety check</span> : null}
          {items.length < (totalReady ?? 0) + (totalBlocked ?? 0) ? <span className="text-fg-3"> · showing top {items.length} by priority</span> : null}
        </p>
        <span className="hidden items-center gap-1 text-[11.5px] text-fg-3 md:flex"><Kbd>j</Kbd><Kbd>k</Kbd> move <Kbd>a</Kbd> approve <Kbd>x</Kbd> reject <Kbd>e</Kbd> edit</span>
        {canEdit ? (
          <div className="ml-auto flex gap-1.5">
            {selected.size ? (
              <>
                <Button size="sm" onClick={() => act(() => approveAction([...selected]))} loading={pending}><Check /> Approve {selected.size}</Button>
                <Button size="sm" variant="ghost" onClick={() => act(() => rejectAction([...selected]))}><X /> Reject {selected.size}</Button>
              </>
            ) : null}
            {ready.length > 0 ? (
              <Button size="sm" variant="primary" loading={pending} onClick={() => act(() => approveAllReadyAction(batchId))}>
                <CheckCheck /> Approve all {batchId ? "in batch" : "clean"} drafts
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>

      {items.map((item, idx) => (
        <div key={item.id} ref={(el) => { refs.current[idx] = el; }} onClick={() => setFocus(idx)}>
          <ReviewCard item={item} focused={idx === focus} canEdit={canEdit} selected={selected.has(item.id)}
            onSelect={() => setSelected((s) => { const n = new Set(s); if (n.has(item.id)) n.delete(item.id); else n.add(item.id); return n; })} />
        </div>
      ))}
    </div>
  );
}

function ReviewCard({ item, focused, canEdit, selected, onSelect }: { item: ReviewItem; focused: boolean; canEdit: boolean; selected: boolean; onSelect: () => void }) {
  const router = useRouter();
  const [body, setBody] = useState(item.body);
  const [subject, setSubject] = useState(item.subject ?? "");
  const [validation, setValidation] = useState<ValidationResult>(item.validation);
  const [angle, setAngle] = useState(item.angle ?? "problem_first");
  const [pending, start] = useTransition();
  const dirty = body !== item.body || (subject || null) !== (item.subject || null);
  const spec = CHANNEL_SPECS[item.channel];
  const blocks = validation.issues.filter((i) => i.severity === "block");
  const warns = validation.issues.filter((i) => i.severity === "warn");

  useEffect(() => {
    setBody(item.body);
    setValidation(item.validation);
  }, [item.body, item.validation]);

  const save = () =>
    start(async () => {
      const r = await editMessageAction(item.id, body, item.channel === "email" ? subject : null);
      if (r.ok) {
        setValidation(r.validation);
        toast(r.validation.ok ? "Saved" : "Saved — still blocked", { kind: r.validation.ok ? "success" : "error" });
        router.refresh();
      } else toast.error(r.error);
    });

  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      if (dirty) {
        const r = await editMessageAction(item.id, body, item.channel === "email" ? subject : null);
        if (!r.ok) return toast.error(r.error);
        if (!r.validation.ok) {
          setValidation(r.validation);
          return toast.error("Still blocked — fix the issues first");
        }
      }
      const r = await fn();
      if (r.ok) toast(r.message ?? "Done");
      else toast.error(r.error ?? "Failed");
      router.refresh();
    });

  return (
    <article className={cn("rounded-lg border bg-surface shadow-sm transition-colors", focused ? "border-border-strong ring-2 ring-[var(--ring)]/40" : "border-border", item.status === "blocked" && "border-danger/30")}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5">
        {canEdit ? <Checkbox checked={selected} onChange={onSelect} aria-label={`Select message to ${item.business_name}`} /> : null}
        <Link href={`/prospects/${item.prospect_id}`} className="font-medium hover:underline">{item.business_name}</Link>
        <span className="text-[12px] text-fg-3">
          {item.instagram_handle ? `@${item.instagram_handle} · ` : ""}{categoryLabel(item.category)}{item.city ? ` · ${item.city}` : ""}
        </span>
        <ScoreBadge score={item.icp_score} label="ICP score" />
        {item.is_demo ? <Badge>demo</Badge> : null}
        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {item.channel === "email" ? <Link href={`/outreach/compose/${item.id}`} className="text-[12px] font-medium text-accent hover:underline">Open composer →</Link> : null}
          <Badge tone="info">{spec.label}</Badge>
          <Badge>{item.kind === "followup" ? `Follow-up ${item.step}` : MESSAGE_ANGLES.find((a) => a.key === item.angle)?.label ?? item.angle ?? "Message"}</Badge>
          <Badge tone={item.generator.startsWith("ai:") ? "accent" : "neutral"}><Sparkles className="size-3" />{generatorLabel(item.generator)}</Badge>
          {item.campaign_name ? <span className="text-[11.5px] text-fg-3">{item.campaign_name}</span> : null}
        </span>
      </header>
      <div className="grid gap-4 p-4 lg:grid-cols-[1fr_260px]">
        <div>
          {item.channel === "email" ? (
            <input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!canEdit} placeholder="Subject"
              className="mb-2 h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] font-medium" aria-label="Email subject" />
          ) : null}
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!canEdit} className="min-h-28 text-[13.5px]" aria-label="Message"
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === "Enter") save(); }} />
          <div className="mt-1.5 flex items-center justify-between text-[11.5px] text-fg-3">
            <span className={cn("tabular", body.length > spec.maxChars && "text-danger")}>{body.length} / {spec.idealChars} ideal · {spec.maxChars} max</span>
            {dirty ? <Button size="xs" onClick={save} loading={pending}>Save & re-check <Kbd>Ctrl ↵</Kbd></Button> : item.edited ? <span>Edited by you</span> : null}
          </div>
        </div>
        <aside className="space-y-2">
          {blocks.length ? (
            <div className="rounded-md border border-danger/25 bg-danger-subtle p-2.5">
              <p className="flex items-center gap-1.5 text-[12px] font-semibold text-danger"><ShieldX className="size-3.5" /> Send blocked</p>
              <ul className="mt-1 space-y-1 text-[12px] text-danger">{blocks.map((b) => <li key={b.code + b.message}>{b.message}</li>)}</ul>
            </div>
          ) : (
            <p className="flex items-center gap-1.5 text-[12px] font-medium text-success"><Check className="size-3.5" /> Passed safety check</p>
          )}
          {warns.length ? (
            <ul className="space-y-1">
              {warns.map((w) => (
                <li key={w.code + w.message} className="flex gap-1.5 text-[12px] text-warning"><AlertTriangle className="mt-0.5 size-3 shrink-0" />{w.message}</li>
              ))}
            </ul>
          ) : null}
          {item.bio ? <p className="line-clamp-3 border-t border-border pt-2 text-[11.5px] text-fg-3" title={item.bio}>Bio: {item.bio}</p> : null}
        </aside>
      </div>
      {canEdit ? (
        <footer className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-2">
          <Button size="sm" variant="primary" disabled={item.status === "blocked" && !dirty} loading={pending} onClick={() => run(() => approveAction([item.id]))}><Check /> Approve</Button>
          <Button size="sm" variant="ghost" onClick={() => run(() => rejectAction([item.id]))}><X /> Reject</Button>
          <span className="mx-1 h-4 w-px bg-border" />
          <Select value={angle} onChange={(e) => setAngle(e.target.value)} className="h-7 w-auto text-[12px]" aria-label="Angle for regenerate">
            {MESSAGE_ANGLES.map((a) => <option key={a.key} value={a.key}>{a.label}</option>)}
          </Select>
          <Button size="sm" variant="ghost" loading={pending} onClick={() => run(() => regenerateAction(item.id, { angle }))}><RefreshCw /> Regenerate</Button>
        </footer>
      ) : null}
    </article>
  );
}
