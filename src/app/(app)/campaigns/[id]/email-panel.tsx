"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Trash2, ShieldCheck, AlertTriangle } from "lucide-react";
import { Panel, Badge } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Checkbox } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import type { ActionResult } from "@/components/ui/dialog";
import { fmtDate } from "@/lib/utils";
import { updateCampaignEmailAction, saveComplianceAction, addCostAction, deleteCostAction } from "../email-actions";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>, done?: () => void) => start(async () => {
    const r = await fn();
    if (r.ok) { toast(r.message ?? "Saved"); done?.(); router.refresh(); } else toast.error(r.error);
  });
  return { pending, run };
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export interface CampaignEmail {
  id: string; code: string | null; senderAccountId: string | null; dailySendCap: number | null; followupDays: number[];
  window: { days: number[]; start: string; end: string; tz: string };
  compliance: Record<string, unknown>;
  costs: { id: string; label: string; amount: number; currency: string; incurred_on: string }[];
  countries: { country: string; name: string; cold_email: string; prospects: number; with_email: number }[];
  missing: string[];
}

export function CampaignEmailPanel({ c, accounts, items, canEdit, isAdmin }: {
  c: CampaignEmail; accounts: { id: string; label: string; status: string }[]; items: { key: string; label: string; help: string }[]; canEdit: boolean; isAdmin: boolean;
}) {
  const { pending, run } = useAct();
  const [sender, setSender] = useState(c.senderAccountId ?? "");
  const [cap, setCap] = useState(c.dailySendCap ? String(c.dailySendCap) : "");
  const [fu, setFu] = useState(c.followupDays.join(", "));
  const [win, setWin] = useState(c.window);
  const [checks, setChecks] = useState<Record<string, boolean>>(Object.fromEntries(items.map((i) => [i.key, Boolean(c.compliance[i.key])])));
  const [cost, setCost] = useState({ label: "", amount: "", currency: c.costs[0]?.currency ?? "NGN", date: new Date().toISOString().slice(0, 10) });
  const blockedCountries = c.countries.filter((x) => x.cold_email !== "allowed" && x.prospects > 0);

  return (
    <>
      <Panel title="Email readiness" description={c.code ? `Campaign id ${c.code}, used in UTM tags and conversion attribution.` : undefined}>
        {c.missing.length ? (
          <ul className="space-y-1 text-[12.5px] text-warning">{c.missing.map((m) => <li key={m} className="flex gap-1.5"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{m}</li>)}</ul>
        ) : <p className="flex items-center gap-1.5 text-[12.5px] text-success"><ShieldCheck className="size-4" /> Ready to send email</p>}
        {c.countries.length ? (
          <div className="mt-3 border-t border-border pt-3">
            <p className="mb-1.5 text-[12px] font-medium text-fg-2">Prospects by country</p>
            <ul className="space-y-1 text-[12.5px]">{c.countries.map((x) => (
              <li key={x.country} className="flex items-center gap-2">
                <span className="w-28 truncate">{x.name}</span>
                <Badge tone={x.cold_email === "allowed" ? "success" : x.cold_email === "blocked" ? "danger" : "warning"}>{x.cold_email === "allowed" ? "Allowed" : x.cold_email === "blocked" ? "Blocked" : "Consent required"}</Badge>
                <span className="ml-auto text-fg-3">{x.with_email} with email / {x.prospects}</span>
              </li>
            ))}</ul>
            {blockedCountries.length ? <p className="mt-2 text-[11.5px] text-fg-3">Prospects in {blockedCountries.map((b) => b.name).join(", ")} won&apos;t be emailed. Change this in <a className="underline" href="/settings/countries">Settings → Country rules</a> only after legal review.</p> : null}
          </div>
        ) : null}
      </Panel>

      <Panel title="Compliance checklist" description="Must be confirmed by an admin before any email in this campaign can send. Recorded in the audit log.">
        <div className="space-y-2.5">
          {items.map((i) => (
            <label key={i.key} className="flex items-start gap-2 text-[12.5px]">
              <Checkbox className="mt-0.5" disabled={!isAdmin} checked={checks[i.key]} onChange={(e) => setChecks({ ...checks, [i.key]: e.target.checked })} />
              <span>{i.label}<span className="block text-[11.5px] text-fg-3">{i.help}</span></span>
            </label>
          ))}
          {c.compliance.at ? <p className="text-[11.5px] text-fg-3">Last confirmed by {String(c.compliance.byName ?? "an admin")} on {fmtDate(String(c.compliance.at))}</p> : null}
          {isAdmin ? <Button size="sm" loading={pending} onClick={() => run(() => saveComplianceAction(c.id, checks))}>Save checklist</Button> : <p className="text-[11.5px] text-fg-3">Only admins can confirm compliance.</p>}
        </div>
      </Panel>

      <Panel title="Sending">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Send from">
            <Select value={sender} disabled={!canEdit} onChange={(e) => setSender(e.target.value)}>
              <option value="">Any active mailbox</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.label}{a.status !== "active" ? ` (${a.status})` : ""}</option>)}
            </Select>
          </Field>
          <Field label="Campaign daily cap" hint="optional, on top of mailbox caps"><Input type="number" value={cap} disabled={!canEdit} onChange={(e) => setCap(e.target.value)} placeholder="No extra cap" /></Field>
          <Field label="Follow-up after (days)" hint="stops on reply, bounce or unsubscribe"><Input value={fu} disabled={!canEdit} onChange={(e) => setFu(e.target.value)} placeholder="3, 7" /></Field>
          <Field label="Time zone"><Input value={win.tz} disabled={!canEdit} onChange={(e) => setWin({ ...win, tz: e.target.value })} /></Field>
          <Field label="Send between">
            <div className="flex items-center gap-2"><Input type="time" value={win.start} disabled={!canEdit} onChange={(e) => setWin({ ...win, start: e.target.value })} /><span className="text-fg-3">–</span><Input type="time" value={win.end} disabled={!canEdit} onChange={(e) => setWin({ ...win, end: e.target.value })} /></div>
          </Field>
          <Field label="On days">
            <div className="flex flex-wrap gap-1">{DAYS.map((d, i) => (
              <button key={d} type="button" disabled={!canEdit} aria-pressed={win.days.includes(i)}
                onClick={() => setWin({ ...win, days: win.days.includes(i) ? win.days.filter((x) => x !== i) : [...win.days, i].sort() })}
                className={`h-7 rounded-md border px-2 text-[12px] ${win.days.includes(i) ? "border-fg bg-fg text-bg" : "border-border text-fg-2"}`}>{d}</button>
            ))}</div>
          </Field>
        </div>
        {canEdit ? (
          <Button size="sm" className="mt-3" loading={pending} onClick={() => run(() => updateCampaignEmailAction(c.id, {
            senderAccountId: sender || null, dailySendCap: cap ? Number(cap) : null,
            followupDays: fu.split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => Number.isFinite(n)), window: win,
          }))}>Save sending settings</Button>
        ) : null}
      </Panel>

      <Panel title="Costs" description="Real spend on this campaign (tools, data, verification credits, time). Used for cost per activated and paid user.">
        {c.costs.length ? (
          <ul className="mb-3 divide-y divide-border text-[12.5px]">{c.costs.map((x) => (
            <li key={x.id} className="flex items-center gap-2 py-1.5">
              <span className="flex-1">{x.label}</span><span className="text-fg-3">{fmtDate(x.incurred_on)}</span>
              <span className="tabular font-medium">{x.currency} {Number(x.amount).toLocaleString()}</span>
              {canEdit ? <button className="text-fg-3 hover:text-danger" aria-label="Remove cost" onClick={() => run(() => deleteCostAction(c.id, x.id))}><Trash2 className="size-3.5" /></button> : null}
            </li>
          ))}</ul>
        ) : <p className="mb-3 text-[12.5px] text-fg-3">No costs recorded. With no costs, cost-per figures show “—”.</p>}
        {canEdit ? (
          <div className="grid gap-2 sm:grid-cols-[1fr_110px_70px_130px_auto] sm:items-end">
            <Field label="What"><Input value={cost.label} onChange={(e) => setCost({ ...cost, label: e.target.value })} placeholder="ZeroBounce credits" /></Field>
            <Field label="Amount"><Input type="number" value={cost.amount} onChange={(e) => setCost({ ...cost, amount: e.target.value })} /></Field>
            <Field label="Currency"><Input value={cost.currency} maxLength={3} onChange={(e) => setCost({ ...cost, currency: e.target.value.toUpperCase() })} /></Field>
            <Field label="Date"><Input type="date" value={cost.date} onChange={(e) => setCost({ ...cost, date: e.target.value })} /></Field>
            <Button size="sm" loading={pending} disabled={!cost.label || !cost.amount} onClick={() => run(() => addCostAction(c.id, { ...cost, amount: Number(cost.amount) }), () => setCost({ ...cost, label: "", amount: "" }))}>Add</Button>
          </div>
        ) : null}
      </Panel>
    </>
  );
}
