"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Mail, Pause, Play, ShieldCheck, Settings2, Unplug, FlaskConical, RefreshCw, KeyRound } from "lucide-react";
import { Panel, Badge, Progress } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Input, Checkbox } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import type { ActionResult } from "@/components/ui/dialog";
import type { SenderUsageRow } from "@/server/services/email-metrics";
import { timeAgo, fmtNum } from "@/lib/utils";
import {
  setSenderPausedAction, updateSenderLimitsAction, checkSenderDnsAction, disconnectSenderAction, createTestSinkAction,
  saveZeroBounceKeyAction, refreshZeroBounceCreditsAction,
} from "./email-actions";

function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<ActionResult>) => start(async () => {
    const r = await fn();
    if (r.ok) { toast(r.message ?? "Done"); router.refresh(); } else toast.error(r.error);
  });
  return { pending, run };
}

const PROVIDER_LABEL: Record<string, string> = { gmail: "Gmail / Google Workspace", microsoft: "Outlook / Microsoft 365", test_sink: "Test mailbox", manual: "Manual" };

function DnsRow({ label, ok, note }: { label: string; ok: boolean | null; note: string }) {
  return (
    <li className="flex gap-2">
      <Badge tone={ok ? "success" : ok === null ? "warning" : "danger"} className="w-14 justify-center">{label}</Badge>
      <span className="text-fg-2">{note}</span>
    </li>
  );
}

function AccountRow({ a, canEdit }: { a: SenderUsageRow; canEdit: boolean }) {
  const { pending, run } = useAct();
  const [editing, setEditing] = useState(false);
  const [cap, setCap] = useState(String(a.daily_cap));
  const [interval, setInterval] = useState(String(a.min_interval_seconds));
  const [warm, setWarm] = useState(a.warmup_enabled);
  const [warmStart, setWarmStart] = useState(String(a.warmup_start_cap));
  const [warmStep, setWarmStep] = useState(String(a.warmup_step));
  const bounceRate = a.sent_30d ? a.bounced_30d / a.sent_30d : 0;
  const complaintRate = a.sent_30d ? a.complained_30d / a.sent_30d : 0;
  const dns = a.dns_checks;
  return (
    <li className="space-y-2 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Mail className="size-4 text-fg-3" />
        <span className="text-[13px] font-medium">{a.email_address ?? a.label}</span>
        <span className="text-[12px] text-fg-3">{PROVIDER_LABEL[a.provider] ?? a.provider}</span>
        <Badge tone={a.status === "active" ? "success" : a.status === "needs_reconnect" ? "danger" : "warning"}>
          {a.status === "active" ? "Active" : a.status === "needs_reconnect" ? "Reconnect needed" : a.status === "paused" ? "Paused" : "Error"}
        </Badge>
        {a.provider === "test_sink" ? <Badge tone="info">Never delivers</Badge> : null}
        <span className="ml-auto inline-flex flex-wrap gap-1">
          {canEdit && a.status === "active" ? <Button size="xs" variant="secondary" disabled={pending} onClick={() => run(() => setSenderPausedAction(a.id, true))}><Pause /> Pause</Button> : null}
          {canEdit && (a.status === "paused" || a.status === "error") ? <Button size="xs" variant="secondary" disabled={pending} onClick={() => run(() => setSenderPausedAction(a.id, false))}><Play /> Resume</Button> : null}
          {a.status === "needs_reconnect" && canEdit ? <a href={`/api/email/oauth/${a.provider}/start`} className="inline-flex h-6 items-center rounded-md border border-border px-2 text-[12px]">Reconnect</a> : null}
          {a.provider !== "test_sink" ? <Button size="xs" variant="ghost" disabled={pending} onClick={() => run(() => checkSenderDnsAction(a.id))}><ShieldCheck /> Check DNS</Button> : null}
          {canEdit ? <Button size="xs" variant="ghost" onClick={() => setEditing(!editing)}><Settings2 /> Limits</Button> : null}
          {canEdit ? <Button size="xs" variant="ghost" disabled={pending} onClick={() => { if (confirm("Disconnect this mailbox? Queued emails go back to Ready.")) run(() => disconnectSenderAction(a.id)); }}><Unplug /></Button> : null}
        </span>
      </div>
      {a.paused_reason && a.status !== "active" ? <p className="text-[12px] text-warning">{a.paused_reason}</p> : null}
      {a.last_error && a.status !== "active" ? <p className="text-[12px] text-danger">Last error: {a.last_error}</p> : null}
      <div className="grid gap-3 text-[12px] sm:grid-cols-4">
        <div>
          <div className="text-fg-3">Sent today</div>
          <div className="font-medium tabular">{fmtNum(a.sent_today)} / {fmtNum(a.cap)}</div>
          <Progress value={a.cap ? Math.min(100, (a.sent_today / a.cap) * 100) : 0} className="mt-1" />
        </div>
        <div>
          <div className="text-fg-3">Today&apos;s cap</div>
          <div className="tabular">{a.warmup_enabled && a.cap < a.daily_cap ? `Warming up → ${a.daily_cap}` : `${a.daily_cap}/day`}{a.provider_daily_limit ? ` · provider max ${fmtNum(a.provider_daily_limit)}` : ""}</div>
          <div className="text-fg-3">≥ {a.min_interval_seconds}s between sends</div>
        </div>
        <div>
          <div className="text-fg-3">Bounce rate (30d)</div>
          <div className={bounceRate > 0.05 ? "font-medium text-danger" : "tabular"}>{a.sent_30d ? `${(bounceRate * 100).toFixed(1)}%` : "—"} <span className="text-fg-3">of {fmtNum(a.sent_30d)}</span></div>
        </div>
        <div>
          <div className="text-fg-3">Complaints (30d)</div>
          <div className={complaintRate > 0.003 ? "font-medium text-danger" : "tabular"}>{a.sent_30d ? `${(complaintRate * 100).toFixed(2)}%` : "—"}</div>
          {a.last_synced_at ? <div className="text-fg-3">Synced {timeAgo(a.last_synced_at)}</div> : null}
        </div>
      </div>
      {dns ? (
        <ul className="space-y-1 rounded-md bg-surface-2 p-2.5 text-[12px]">
          {dns.managedByProvider ? <li className="text-fg-2">{dns.domain} is authenticated by the mail provider (SPF/DKIM/DMARC managed for you).</li> : (
            <>
              <DnsRow label="SPF" ok={dns.spf.ok} note={dns.spf.note} />
              <DnsRow label="DKIM" ok={dns.dkim.ok} note={dns.dkim.note} />
              <DnsRow label="DMARC" ok={dns.dmarc.ok} note={dns.dmarc.note} />
            </>
          )}
          <li className="text-fg-3">Checked {timeAgo(dns.checkedAt)}</li>
        </ul>
      ) : null}
      {editing ? (
        <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-5">
          <Field label="Daily cap"><Input type="number" value={cap} onChange={(e) => setCap(e.target.value)} /></Field>
          <Field label="Min seconds between"><Input type="number" value={interval} onChange={(e) => setInterval(e.target.value)} /></Field>
          <Field label="Warm-up start"><Input type="number" value={warmStart} disabled={!warm} onChange={(e) => setWarmStart(e.target.value)} /></Field>
          <Field label="+ per week"><Input type="number" value={warmStep} disabled={!warm} onChange={(e) => setWarmStep(e.target.value)} /></Field>
          <div className="flex flex-col justify-end gap-2">
            <label className="flex items-center gap-2 text-[12.5px]"><Checkbox checked={warm} onChange={(e) => setWarm(e.target.checked)} /> Warm-up</label>
            <Button size="sm" variant="primary" disabled={pending} onClick={() => run(async () => {
              const r = await updateSenderLimitsAction(a.id, { dailyCap: Number(cap), minIntervalSeconds: Number(interval), warmupEnabled: warm, warmupStartCap: Number(warmStart), warmupStep: Number(warmStep) });
              if (r.ok) setEditing(false);
              return r;
            })}>Save</Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function SendingAccounts({ accounts, canEdit, configured, testSink, flash }: {
  accounts: SenderUsageRow[]; canEdit: boolean; configured: { gmail: boolean; microsoft: boolean }; testSink: boolean;
  flash: { connected?: string; error?: string };
}) {
  const { pending, run } = useAct();
  const totalCap = accounts.filter((a) => a.status === "active" && a.provider !== "test_sink").reduce((n, a) => n + a.cap, 0);
  return (
    <Panel id="sending" padded={false} title="Sending accounts"
      description="Email is sent from your own mailbox through Google's or Microsoft's official API. You sign in on their page; we never see your password. Tokens are stored encrypted on the server.">
      {flash.connected ? <p className="mx-4 mt-3 rounded-md bg-success-subtle px-3 py-2 text-[12.5px] text-success">Connected {flash.connected}</p> : null}
      {flash.error ? <p className="mx-4 mt-3 rounded-md bg-danger-subtle px-3 py-2 text-[12.5px] text-danger">{flash.error}</p> : null}
      {accounts.length === 0 ? (
        <p className="px-4 py-4 text-[12.5px] text-fg-3">No sending accounts yet. Connect the mailbox you want prospects to reply to.</p>
      ) : (
        <ul className="divide-y divide-border">{accounts.map((a) => <AccountRow key={a.id} a={a} canEdit={canEdit} />)}</ul>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        {canEdit ? (
          <>
            <a href="/api/email/oauth/gmail/start" aria-disabled={!configured.gmail}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium ${configured.gmail ? "border-border-strong hover:bg-surface-2" : "pointer-events-none border-border text-fg-3"}`}><Mail className="size-3.5" /> Connect Gmail</a>
            <a href="/api/email/oauth/microsoft/start" aria-disabled={!configured.microsoft}
              className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-3 text-[12.5px] font-medium ${configured.microsoft ? "border-border-strong hover:bg-surface-2" : "pointer-events-none border-border text-fg-3"}`}><Mail className="size-3.5" /> Connect Outlook</a>
            {testSink && !accounts.some((a) => a.provider === "test_sink") ? (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(createTestSinkAction)}><FlaskConical /> Add test mailbox (dev)</Button>
            ) : null}
          </>
        ) : null}
        <span className="ml-auto text-[12px] text-fg-3">Combined cap today: {fmtNum(totalCap)} emails</span>
      </div>
      {!configured.gmail || !configured.microsoft ? (
        <p className="border-t border-border px-4 py-2.5 text-[12px] text-fg-3">
          {!configured.gmail ? "Gmail needs GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET. " : ""}{!configured.microsoft ? "Outlook needs MS_CLIENT_ID / MS_CLIENT_SECRET. " : ""}
          Both are free to create; step-by-step in docs/email.md.
        </p>
      ) : null}
    </Panel>
  );
}

export function VerificationSetup({ zb, canEdit, envKey }: { zb: { connected: boolean; credits: number | null; checkedAt: string | null }; canEdit: boolean; envKey: boolean }) {
  const { pending, run } = useAct();
  const [key, setKey] = useState("");
  return (
    <Panel title="Email finding & verification" description="How addresses are found and checked. The system never guesses addresses and never sends probe emails.">
      <ul className="space-y-3 text-[12.5px]">
        <li className="flex gap-2"><Badge tone="success">Ready</Badge><span><span className="font-medium">Website email finder</span>: reads a business&apos;s own homepage and contact pages (max 5 pages, respects robots.txt) and records the page each address came from.</span></li>
        <li className="flex gap-2"><Badge tone="success">Ready</Badge><span><span className="font-medium">Free DNS check</span>: syntax, disposable domains and mail servers (MX). It can rule an address out but can&apos;t confirm a mailbox exists, so passing addresses are marked <em>Deliverability unknown</em>, never Verified.</span></li>
        <li className="flex gap-2">
          <Badge tone={zb.connected || envKey ? "success" : "neutral"}>{zb.connected || envKey ? "Connected" : "Optional"}</Badge>
          <span><span className="font-medium">ZeroBounce</span>: mailbox-level verification. Free tier gives 100 checks a month (business email signup); after that it&apos;s pay-as-you-go. Only ZeroBounce results can mark an address <em>Verified</em>.
            {zb.credits != null ? <> · <span className="font-medium">{fmtNum(zb.credits)} credits left</span>{zb.checkedAt ? <span className="text-fg-3"> (checked {timeAgo(zb.checkedAt)})</span> : null}</> : null}
          </span>
        </li>
      </ul>
      {canEdit && !envKey ? (
        <div className="mt-4 flex flex-wrap items-end gap-2">
          <Field label={<span className="inline-flex items-center gap-1"><KeyRound className="size-3" /> ZeroBounce API key</span>} className="min-w-[240px] flex-1">
            <Input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={zb.connected ? "•••••••• (saved, enter a new key to replace)" : "Paste key"} autoComplete="off" />
          </Field>
          <Button size="sm" variant="primary" disabled={pending || !key.trim()} onClick={() => run(async () => { const r = await saveZeroBounceKeyAction(key); if (r.ok) setKey(""); return r; })}>Save</Button>
          {zb.connected ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => saveZeroBounceKeyAction(""))}>Remove</Button> : null}
          {zb.connected ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(refreshZeroBounceCreditsAction)}><RefreshCw /> Credits</Button> : null}
        </div>
      ) : envKey ? <p className="mt-3 text-[12px] text-fg-3">Using ZEROBOUNCE_API_KEY from the server environment.</p> : null}
    </Panel>
  );
}
