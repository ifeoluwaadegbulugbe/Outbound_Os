"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Send, Save, RefreshCw, Copy, SkipForward, FlaskConical, Clock, CheckCircle2, AlertTriangle, Check } from "lucide-react";
import { Panel, Badge } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { EmailStatusBadge } from "@/components/email-status";
import { editMessageAction, regenerateAction, rejectAction, approveAction } from "../../actions";
import { sendEmailNowAction, sendTestEmailAction, queueEmailsAction, setPrimaryEmailAction, setMessageSenderAction } from "../../email-actions";
import { timeAgo } from "@/lib/utils";

export interface ComposerData {
  id: string; prospectId: string; status: string; subject: string; body: string; kind: string; step: number;
  to: string | null; toStatus: string; contacts: { value: string; status: string; isRole: boolean }[];
  accounts: { id: string; label: string; provider: string; status: string }[]; senderAccountId: string | null;
  error: string | null; issues: { code: string; severity: string; message: string }[];
  eligibility: string | null; needsVerification: boolean; footerPreview: string;
  sentAt: string | null; providerMessageId: string | null; deliveryStatus: string | null; defaultTestTo: string;
}

const EDITABLE = ["draft", "needs_review", "approved", "blocked", "failed", "scheduled"];

export function Composer({ data, canEdit }: { data: ComposerData; canEdit: boolean }) {
  const router = useRouter();
  const [subject, setSubject] = useState(data.subject);
  const [body, setBody] = useState(data.body);
  const [issues, setIssues] = useState(data.issues);
  const [testTo, setTestTo] = useState(data.defaultTestTo);
  const [showTest, setShowTest] = useState(false);
  const [lastError, setLastError] = useState<string | null>(data.status === "failed" || data.status === "approved" ? data.error : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [, start] = useTransition();
  const dirty = subject !== data.subject || body !== data.body;
  const editable = canEdit && EDITABLE.includes(data.status);
  const isSent = data.status === "sent" || data.status === "sending";
  const isQueued = data.status === "queued";

  const act = (name: string, fn: () => Promise<{ ok: boolean; message?: string; error?: string; data?: unknown }>, after?: (r: { data?: unknown }) => void) =>
    start(async () => {
      setBusy(name);
      try {
        const r = await fn();
        if (r.ok) {
          toast(r.message ?? "Done");
          setLastError(null);
          after?.(r);
          router.refresh();
        } else {
          toast.error(r.error ?? "Failed");
          if (name === "send") setLastError(r.error ?? "Failed");
        }
      } finally {
        setBusy(null);
      }
    });

  const save = async () => {
    if (!dirty) return { ok: true as const };
    const r = await editMessageAction(data.id, body, subject);
    if (r.ok) setIssues(r.validation.issues);
    return r.ok ? { ok: true as const } : { ok: false as const, error: r.error };
  };

  const blocks = issues.filter((i) => i.severity === "block");
  const warns = issues.filter((i) => i.severity !== "block");

  return (
    <Panel padded={false}>
      {isSent ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-success-subtle/60 px-4 py-2.5 text-[12.5px] text-success">
          <CheckCircle2 className="size-4" />
          {data.status === "sending" ? "Sending… waiting for the provider to confirm." : <>Sent {data.sentAt ? timeAgo(data.sentAt) : ""} · provider id <code className="font-mono text-[11.5px]">{data.providerMessageId}</code></>}
          {data.deliveryStatus ? <Badge tone={data.deliveryStatus === "bounced" || data.deliveryStatus === "complained" ? "danger" : "success"}>{data.providerMessageId?.startsWith("sink_") ? "Captured by test mailbox, not delivered" : data.deliveryStatus === "accepted" ? "Accepted by mail server" : data.deliveryStatus}</Badge> : null}
        </div>
      ) : null}
      {isQueued ? (
        <div className="flex items-center gap-2 border-b border-border bg-info-subtle/60 px-4 py-2.5 text-[12.5px] text-info"><Clock className="size-4" /> Queued: it goes out automatically within the account&apos;s limits and send window.</div>
      ) : null}
      {lastError ? (
        <div className="flex gap-2 border-b border-border bg-danger-subtle px-4 py-2.5 text-[12.5px] text-danger" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <div><span className="font-medium">Not sent.</span> {lastError} <span className="text-fg-3">The draft is saved and nothing was marked as sent.</span></div>
        </div>
      ) : null}
      {data.eligibility && !isSent ? (
        <div className="flex gap-2 border-b border-border bg-warning-subtle px-4 py-2.5 text-[12.5px] text-warning"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> Can&apos;t send to this recipient: {data.eligibility}</div>
      ) : null}

      <div className="space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="To">
            {data.contacts.length > 1 && editable ? (
              <Select value={data.to ?? ""} onChange={(e) => act("to", () => setPrimaryEmailAction(data.prospectId, e.target.value))}>
                {data.contacts.map((c) => <option key={c.value} value={c.value}>{c.value}{c.isRole ? " (role address)" : ""} · {c.status.replace("_", " ")}</option>)}
              </Select>
            ) : (
              <div className="flex h-8 items-center gap-2 rounded-md border border-border bg-surface-2 px-2.5 text-[13px]">
                <span className="truncate">{data.to ?? "No email address"}</span>
              </div>
            )}
            <div className="mt-1 flex items-center gap-2"><EmailStatusBadge status={data.to ? data.toStatus : "none"} />{data.needsVerification ? <span className="text-[11.5px] text-fg-3">Will be checked automatically before sending</span> : null}</div>
          </Field>
          <Field label="From">
            <Select value={data.senderAccountId ?? ""} disabled={!editable} onChange={(e) => act("from", () => setMessageSenderAction(data.id, e.target.value || null))}>
              <option value="">{data.accounts.length ? "Campaign default / first available" : "No mailbox connected"}</option>
              {data.accounts.map((a) => <option key={a.id} value={a.id} disabled={a.status !== "active"}>{a.label}{a.provider === "test_sink" ? " (test, never delivers)" : ""}{a.status !== "active" ? ` (${a.status})` : ""}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Subject" hint={`${subject.length}/60`}>
          <Input value={subject} onChange={(e) => setSubject(e.target.value)} disabled={!editable} placeholder="Short, honest subject" />
        </Field>
        <Field label="Message" hint={`${body.length} characters`}>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} disabled={!editable} className="min-h-[220px] font-[inherit] text-[13.5px] leading-relaxed" />
        </Field>
        <div className="rounded-md border border-dashed border-border px-3 py-2 text-[11.5px] text-fg-3">
          Added automatically when sent: “—<br />{data.footerPreview || <span className="text-warning">Set your name and business address in Settings → Email</span>}<br />Don&apos;t want these emails? Unsubscribe”
        </div>
        {blocks.length || warns.length ? (
          <ul className="space-y-1 text-[12px]">
            {blocks.map((i) => <li key={i.code} className="text-danger">✕ {i.message}</li>)}
            {warns.map((i) => <li key={i.code} className="text-warning">! {i.message}</li>)}
          </ul>
        ) : null}
      </div>

      {canEdit && !isSent ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-3">
          {editable ? (
            <>
              <Button size="sm" variant="primary" loading={busy === "send"} disabled={!!busy || !data.to || !!data.eligibility || isQueued}
                onClick={() => act("send", async () => { const s = await save(); return s.ok ? sendEmailNowAction(data.id) : s; })}><Send /> Send</Button>
              <Button size="sm" loading={busy === "queue"} disabled={!!busy || !data.to || !!data.eligibility}
                onClick={() => act("queue", async () => { const s = await save(); return s.ok ? queueEmailsAction([data.id]) : s; })}><Clock /> Approve &amp; queue</Button>
              {data.status === "needs_review" ? (
                <Button size="sm" variant="ghost" loading={busy === "approve"} disabled={!!busy} onClick={() => act("approve", async () => { const s = await save(); return s.ok ? approveAction([data.id]) : s; })}><Check /> Approve only</Button>
              ) : null}
              <Button size="sm" variant="ghost" loading={busy === "save"} disabled={!!busy || !dirty} onClick={() => act("save", async () => { const s = await save(); return s.ok ? { ok: true, message: "Draft saved" } : s; })}><Save /> Save draft</Button>
              <Button size="sm" variant="ghost" loading={busy === "regen"} disabled={!!busy}
                onClick={() => act("regen", () => regenerateAction(data.id, {}), (r) => { const nid = (r.data as { id?: string } | undefined)?.id; if (nid) router.replace(`/outreach/compose/${nid}`); })}><RefreshCw /> Regenerate</Button>
            </>
          ) : null}
          <Button size="sm" variant="ghost" onClick={async () => { await navigator.clipboard.writeText(`Subject: ${subject}\n\n${body}`); toast("Copied subject and message"); }}><Copy /> Copy</Button>
          <Button size="sm" variant="ghost" onClick={() => setShowTest(!showTest)}><FlaskConical /> Send test</Button>
          {editable ? (
            <Button size="sm" variant="ghost" className="ml-auto" disabled={!!busy} onClick={() => act("skip", () => rejectAction([data.id], "skipped"), () => router.push("/outreach"))}><SkipForward /> Skip</Button>
          ) : null}
        </div>
      ) : null}
      {showTest ? (
        <div className="flex flex-wrap items-end gap-2 border-t border-border px-4 py-3">
          <Field label="Send a test copy to (yourself)" className="min-w-[240px] flex-1"><Input type="email" value={testTo} onChange={(e) => setTestTo(e.target.value)} /></Field>
          <Button size="sm" loading={busy === "test"} disabled={!!busy || !testTo} onClick={() => act("test", async () => { const s = await save(); return s.ok ? sendTestEmailAction(data.id, testTo) : s; })}>Send test</Button>
          <p className="w-full text-[11.5px] text-fg-3">Goes through your connected mailbox with “[Test]” in the subject. It doesn&apos;t count as outreach or change the draft.</p>
        </div>
      ) : null}
    </Panel>
  );
}
