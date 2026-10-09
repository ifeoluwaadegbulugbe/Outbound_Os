"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Send, Clock, Undo2, PenLine } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/form";
import { Badge } from "@/components/ui/display";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { toast } from "@/components/ui/toast";
import { EmailStatusBadge } from "@/components/email-status";
import { fmtNum, timeAgo } from "@/lib/utils";
import { sendEmailNowAction, queueEmailsAction, unqueueEmailsAction } from "./email-actions";

export interface EmailRow {
  id: string; prospect_id: string; business_name: string; email: string | null; email_status: string; subject: string | null; kind: string; step: number;
  campaign_name: string | null; status: string; error: string | null; queued_at: Date | null; sent_at: Date | null; to_email: string | null;
  delivery_status: string | null; sender: string | null; city: string | null;
}

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, done?: () => void) => start(async () => {
    const r = await fn();
    if (r.ok) { toast(r.message ?? "Done"); done?.(); } else toast.error(r.error ?? "Failed");
    router.refresh();
  });
  return { pending, run };
}

export function EmailReadyList({ rows, total, canEdit }: { rows: EmailRow[]; total: number; canEdit: boolean }) {
  const { pending, run } = useRun();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [sending, setSending] = useState<string | null>(null);
  const all = rows.length > 0 && rows.every((r) => sel.has(r.id));
  return (
    <>
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
          <span className="text-[12.5px] text-fg-2">{fmtNum(total)} approved email{total === 1 ? "" : "s"} ready</span>
          <span className="ml-auto flex gap-1.5">
            {sel.size ? <Button size="xs" disabled={pending} onClick={() => run(() => queueEmailsAction([...sel]), () => setSel(new Set()))}><Clock /> Queue {sel.size} selected</Button> : null}
            <Button size="xs" variant="primary" disabled={pending || !total} onClick={() => run(() => queueEmailsAction("all_approved"))}><Clock /> Queue all {fmtNum(total)}</Button>
          </span>
        </div>
      ) : null}
      <Table>
        <thead><tr>
          {canEdit ? <Th className="w-8 pr-0"><Checkbox checked={all} onChange={() => setSel(all ? new Set() : new Set(rows.map((r) => r.id)))} aria-label="Select all" /></Th> : null}
          <Th>Business</Th><Th>To</Th><Th className="hidden md:table-cell">Subject</Th><Th className="w-1" />
        </tr></thead>
        <tbody>{rows.map((r) => (
          <Tr key={r.id}>
            {canEdit ? <Td className="w-8 pr-0"><Checkbox checked={sel.has(r.id)} onChange={() => { const n = new Set(sel); if (n.has(r.id)) n.delete(r.id); else n.add(r.id); setSel(n); }} aria-label={`Select ${r.business_name}`} /></Td> : null}
            <Td><Link href={`/prospects/${r.prospect_id}`} className="font-medium hover:underline">{r.business_name}</Link><div className="text-[11.5px] text-fg-3">{r.kind === "followup" ? `Follow-up ${r.step}` : "First email"}{r.campaign_name ? ` · ${r.campaign_name}` : ""}</div></Td>
            <Td><div className="max-w-[220px] truncate text-[12.5px]">{r.email ?? "—"}</div><EmailStatusBadge status={r.email ? r.email_status : "none"} /></Td>
            <Td className="hidden max-w-[360px] md:table-cell"><p className="truncate text-fg-2">{r.subject ?? <span className="text-danger">No subject</span>}</p>{r.error ? <p className="truncate text-[11.5px] text-danger" title={r.error}>Last attempt failed: {r.error}</p> : null}</Td>
            <Td className="whitespace-nowrap">
              <span className="flex gap-1">
                <Link href={`/outreach/compose/${r.id}`} className="inline-flex h-6 items-center gap-1 rounded-md px-2 text-[12px] text-fg-2 hover:bg-surface-2"><PenLine className="size-3.5" /> Open</Link>
                {canEdit ? <Button size="xs" variant="primary" loading={sending === r.id} disabled={pending} onClick={() => { setSending(r.id); run(() => sendEmailNowAction(r.id), () => setSending(null)); }}><Send /> Send</Button> : null}
              </span>
            </Td>
          </Tr>
        ))}</tbody>
      </Table>
    </>
  );
}

export function EmailQueuedList({ rows, total, canEdit, nextNote }: { rows: EmailRow[]; total: number; canEdit: boolean; nextNote: string }) {
  const { pending, run } = useRun();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
        <span className="text-[12.5px] text-fg-2">{fmtNum(total)} queued · {nextNote}</span>
        {canEdit && total ? <Button size="xs" className="ml-auto" disabled={pending} onClick={() => run(() => unqueueEmailsAction("all"))}><Undo2 /> Move all back to Ready</Button> : null}
      </div>
      <Table>
        <thead><tr><Th>Business</Th><Th>To</Th><Th className="hidden md:table-cell">Subject</Th><Th>Status</Th><Th className="w-1" /></tr></thead>
        <tbody>{rows.map((r) => (
          <Tr key={r.id}>
            <Td><Link href={`/outreach/compose/${r.id}`} className="font-medium hover:underline">{r.business_name}</Link><div className="text-[11.5px] text-fg-3">{r.kind === "followup" ? `Follow-up ${r.step}` : "First email"}</div></Td>
            <Td className="max-w-[200px] truncate text-[12.5px]">{r.email}</Td>
            <Td className="hidden max-w-[320px] truncate text-fg-2 md:table-cell">{r.subject}{r.error ? <p className="truncate text-[11.5px] text-warning" title={r.error}>Retrying: {r.error}</p> : null}</Td>
            <Td>{r.status === "sending" ? <Badge tone="info">Sending…</Badge> : <span className="text-[12px] text-fg-3">queued {timeAgo(r.queued_at)}</span>}</Td>
            <Td>{canEdit && r.status === "queued" ? <Button size="xs" variant="ghost" disabled={pending} onClick={() => run(() => unqueueEmailsAction([r.id]))}><Undo2 /></Button> : null}</Td>
          </Tr>
        ))}</tbody>
      </Table>
    </>
  );
}

const DELIVERY: Record<string, { label: string; tone: "success" | "info" | "danger" | "warning" | "neutral" }> = {
  accepted: { label: "Accepted", tone: "info" },
  delivered: { label: "Delivered (no bounce)", tone: "success" },
  bounced: { label: "Bounced", tone: "danger" },
  complained: { label: "Spam complaint", tone: "danger" },
  deferred: { label: "Deferred", tone: "warning" },
};

export function EmailSentList({ rows }: { rows: (EmailRow & { replied: boolean })[] }) {
  return (
    <Table>
      <thead><tr><Th>Business</Th><Th>To</Th><Th className="hidden md:table-cell">Subject</Th><Th>Delivery</Th><Th className="hidden lg:table-cell">From</Th><Th>Sent</Th></tr></thead>
      <tbody>{rows.map((r) => {
        const d = DELIVERY[r.delivery_status ?? "accepted"] ?? DELIVERY.accepted;
        return (
          <Tr key={r.id}>
            <Td><Link href={`/outreach/compose/${r.id}`} className="font-medium hover:underline">{r.business_name}</Link><div className="text-[11.5px] text-fg-3">{r.kind === "followup" ? `Follow-up ${r.step}` : "First email"}{r.campaign_name ? ` · ${r.campaign_name}` : ""}</div></Td>
            <Td className="max-w-[200px] truncate text-[12.5px]">{r.to_email}</Td>
            <Td className="hidden max-w-[300px] truncate text-fg-2 md:table-cell">{r.subject}</Td>
            <Td><span className="flex flex-wrap gap-1"><Badge tone={d.tone}>{d.label}</Badge>{r.replied ? <Badge tone="success">Replied</Badge> : null}</span></Td>
            <Td className="hidden max-w-[180px] truncate text-[12px] text-fg-3 lg:table-cell">{r.sender}</Td>
            <Td className="whitespace-nowrap text-[12px] text-fg-3">{timeAgo(r.sent_at)}</Td>
          </Tr>
        );
      })}</tbody>
    </Table>
  );
}
