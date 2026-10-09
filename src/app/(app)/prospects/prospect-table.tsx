"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Ban, MessageSquarePlus, Target, RefreshCw, ChevronDown, AtSign, Phone, Music2, Mail, MailSearch, MailCheck } from "lucide-react";
import { Table, Th, Td, Tr } from "@/components/ui/table";
import { ScoreBadge, Badge } from "@/components/ui/display";
import { StatusBadge } from "@/components/ui/status";
import { Checkbox, Select, Textarea } from "@/components/ui/form";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { toast } from "@/components/ui/toast";
import { categoryLabel, PROSPECT_STATUSES, STATUS_LABELS, CHANNEL_LABELS, type Channel } from "@/server/domain/taxonomy";
import { cn, fmtCompact, fmtNum, timeAgo, withParams } from "@/lib/utils";
import type { ProspectRow } from "@/server/repos/prospects";
import { addToCampaignAction, setStatusAction, doNotContactAction, rescoreAction, findEmailsAction, verifyEmailsAction, type Selection } from "./actions";
import { EmailStatusBadge } from "@/components/email-status";
import { generateMessagesAction } from "../outreach/actions";
import { ArrowDown, ArrowUp } from "lucide-react";

type Dlg = null | "campaign" | "status" | "dnc" | "generate";

export function ProspectTable({
  rows, total, params, campaigns, canEdit, sort, dir,
}: { rows: ProspectRow[]; total: number; params: Record<string, string>; campaigns: { id: string; name: string }[]; canEdit: boolean; sort: string; dir: "asc" | "desc" }) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  const [dlg, setDlg] = useState<Dlg>(null);
  const [pending, start] = useTransition();
  const [campaignId, setCampaignId] = useState(campaigns[0]?.id ?? "");
  const [status, setStatus] = useState("QUALIFIED");
  const [dncReason, setDncReason] = useState("manual");
  const [dncNote, setDncNote] = useState("");
  const [genChannel, setGenChannel] = useState("email");

  const allOnPage = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const count = allMatching ? total : selected.size;
  const selection = (): Selection => (allMatching ? { allMatching: params } : { ids: [...selected] });

  const toggle = (id: string) => {
    setAllMatching(false);
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast(r.message ?? "Done");
        setDlg(null);
        setSelected(new Set());
        setAllMatching(false);
        router.refresh();
      } else toast.error(r.error ?? "Failed");
    });

  const sortHref = (field: string) => withParams("/prospects", params, { sort: field, dir: sort === field && dir === "desc" ? "asc" : "desc", page: null });
  const SortHead = ({ field, children, className }: { field: string; children: React.ReactNode; className?: string }) => (
    <Th className={className}>
      <Link href={sortHref(field)} scroll={false} className={cn("inline-flex items-center gap-1 hover:text-fg", sort === field && "text-fg")}>
        {children}
        {sort === field ? dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
      </Link>
    </Th>
  );

  return (
    <>
      {count > 0 && canEdit ? (
        <div className="sticky top-11 z-10 flex flex-wrap items-center gap-2 border-b border-border bg-accent-subtle/60 px-4 py-2 backdrop-blur">
          <span className="text-[12.5px] font-medium">{fmtNum(count)} selected</span>
          {allOnPage && !allMatching && total > rows.length ? (
            <button className="text-[12px] text-accent underline-offset-2 hover:underline" onClick={() => setAllMatching(true)}>
              Select all {fmtNum(total)} matching
            </button>
          ) : null}
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button size="xs" variant="primary" onClick={() => setDlg("generate")}><MessageSquarePlus /> Generate email drafts</Button>
            <Button size="xs" onClick={() => run(() => findEmailsAction(selection()))} loading={pending && dlg === null}><MailSearch /> Find emails</Button>
            <Button size="xs" onClick={() => run(() => verifyEmailsAction(selection()))} loading={pending && dlg === null}><MailCheck /> Verify</Button>
            <Button size="xs" onClick={() => setDlg("campaign")} disabled={!campaigns.length}><Target /> Add to campaign</Button>
            <Button size="xs" onClick={() => setDlg("status")}><ChevronDown /> Set status</Button>
            <Button size="xs" onClick={() => run(() => rescoreAction(selection()))} loading={pending && dlg === null}><RefreshCw /> Re-score</Button>
            <Button size="xs" variant="ghost" onClick={() => setDlg("dnc")}><Ban /> Do not contact</Button>
            <Button size="xs" variant="ghost" onClick={() => { setSelected(new Set()); setAllMatching(false); }}>Clear</Button>
          </div>
        </div>
      ) : null}

      <Table>
        <thead>
          <tr>
            {canEdit ? (
              <Th className="w-8 pr-0">
                <Checkbox aria-label="Select all on page" checked={allOnPage} onChange={() => {
                  setAllMatching(false);
                  setSelected(allOnPage ? new Set() : new Set(rows.map((r) => r.id)));
                }} />
              </Th>
            ) : null}
            <SortHead field="name">Business</SortHead>
            <Th className="hidden md:table-cell">Category</Th>
            <SortHead field="email">Email</SortHead>
            <SortHead field="city" className="hidden md:table-cell">City</SortHead>
            <SortHead field="icp">ICP</SortHead>
            <SortHead field="priority" className="hidden sm:table-cell">Priority</SortHead>
            <SortHead field="status">Status</SortHead>
            <Th className="hidden lg:table-cell">Reach</Th>
            <SortHead field="followers" className="hidden xl:table-cell">Followers</SortHead>
            <SortHead field="contacted" className="hidden lg:table-cell">Last contact</SortHead>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              {canEdit ? (
                <Td className="w-8 pr-0">
                  <Checkbox aria-label={`Select ${r.business_name}`} checked={allMatching || selected.has(r.id)} onChange={() => toggle(r.id)} />
                </Td>
              ) : null}
              <Td className="max-w-[280px]">
                <Link href={`/prospects/${r.id}`} className="block min-w-0">
                  <span className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-fg hover:underline">{r.business_name}</span>
                    {r.is_demo ? <Badge className="h-4 px-1 text-[10px]">demo</Badge> : null}
                  </span>
                  <span className="block truncate text-[11.5px] text-fg-3">
                    {r.instagram_handle ? `@${r.instagram_handle}` : r.tiktok_handle ? `@${r.tiktok_handle} (TikTok)` : r.owner_name ?? r.source.replace(/_/g, " ")}
                    <span className="md:hidden"> · {categoryLabel(r.category)} · {r.city ?? "—"}</span>
                  </span>
                </Link>
              </Td>
              <Td className="hidden whitespace-nowrap text-fg-2 md:table-cell">{categoryLabel(r.category)}</Td>
              <Td className="max-w-[220px]">
                {r.email ? (
                  <span className="block min-w-0">
                    <span className="block truncate text-[12.5px] text-fg" title={r.email}>{r.email}</span>
                    <EmailStatusBadge status={r.email_status} />
                  </span>
                ) : r.website && !r.website_checked_at ? <span className="text-[12px] text-fg-3">Website not checked</span>
                  : <EmailStatusBadge status="none" />}
              </Td>
              <Td className="hidden whitespace-nowrap text-fg-2 md:table-cell">{r.city ?? <span className="text-fg-3">—</span>}{r.country && r.country !== "NG" ? <span className="text-fg-3"> · {r.country}</span> : null}</Td>
              <Td><ScoreBadge score={r.icp_score} /></Td>
              <Td className="hidden sm:table-cell">
                <span className={cn("tabular text-[12.5px]", r.outreach_priority === "high" ? "font-semibold text-fg" : "text-fg-2")}>{r.priority_score ?? "—"}</span>
              </Td>
              <Td><StatusBadge status={r.status} /></Td>
              <Td className="hidden lg:table-cell">
                <span className="flex items-center gap-1.5 text-fg-3">
                  {r.instagram_handle ? <AtSign className="size-3.5" aria-label="Instagram" /> : null}
                  {r.tiktok_handle ? <Music2 className="size-3.5" aria-label="TikTok" /> : null}
                  {r.whatsapp || r.phone ? <Phone className="size-3.5" aria-label="WhatsApp/phone" /> : null}
                  {r.email ? <Mail className="size-3.5" aria-label="Email" /> : null}
                </span>
              </Td>
              <Td className="hidden tabular text-fg-2 xl:table-cell">{fmtCompact(r.follower_count)}</Td>
              <Td className="hidden whitespace-nowrap text-[12px] text-fg-3 lg:table-cell">{r.last_contacted_at ? timeAgo(r.last_contacted_at) : "Never"}</Td>
            </Tr>
          ))}
        </tbody>
      </Table>

      <Dialog open={dlg === "campaign"} onClose={() => setDlg(null)} title={`Add ${fmtNum(count)} to campaign`}
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" loading={pending} onClick={() => run(() => addToCampaignAction(selection(), campaignId))}>Add</Button></>}>
        <Select value={campaignId} onChange={(e) => setCampaignId(e.target.value)} aria-label="Campaign">
          {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </Select>
      </Dialog>

      <Dialog open={dlg === "status"} onClose={() => setDlg(null)} title={`Set status for ${fmtNum(count)}`} description="Only valid transitions are applied; the rest are skipped and reported."
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" loading={pending} onClick={() => run(() => setStatusAction(selection(), status))}>Apply</Button></>}>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
          {PROSPECT_STATUSES.filter((s) => s !== "DO_NOT_CONTACT").map((s) => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </Select>
      </Dialog>

      <Dialog open={dlg === "dnc"} onClose={() => setDlg(null)} title={`Do not contact ${fmtNum(count)}?`}
        description="They'll be suppressed permanently (handles, phone, email), pending follow-ups are cancelled and unsent drafts are blocked. Admins can restore."
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="danger" loading={pending} onClick={() => run(() => doNotContactAction(selection(), dncReason, dncNote))}>Add to do-not-contact</Button></>}>
        <div className="space-y-3">
          <Select value={dncReason} onChange={(e) => setDncReason(e.target.value)} aria-label="Reason">
            <option value="manual">Manual blacklist</option>
            <option value="opt_out">Asked not to be contacted</option>
            <option value="customer">Already a customer</option>
            <option value="competitor">Competitor</option>
            <option value="invalid">Invalid business</option>
            <option value="closed">Closed business</option>
            <option value="inappropriate">Inappropriate</option>
          </Select>
          <Textarea value={dncNote} onChange={(e) => setDncNote(e.target.value)} placeholder="Note (optional)" className="min-h-14" />
        </div>
      </Dialog>

      <Dialog open={dlg === "generate"} onClose={() => setDlg(null)} title={`Generate messages for ${fmtNum(count)}`}
        description="Drafts are generated in the background, validated, and land in Send Queue → Review. Nothing is sent until you approve it. Prospects without a usable email are skipped for email."
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" loading={pending} onClick={() => run(async () => {
          const r = await generateMessagesAction({ selection: selection(), channel: genChannel, campaignId: params.campaign ?? null });
          if (r.ok) router.push("/outreach");
          return r;
        })}>Generate drafts</Button></>}>
        <div className="space-y-2">
          <label className="text-[12px] font-medium text-fg-2" htmlFor="gen-channel">Channel</label>
          <Select id="gen-channel" value={genChannel} onChange={(e) => setGenChannel(e.target.value)}>
            <option value="auto">Best available per prospect (Email → Instagram → WhatsApp → TikTok)</option>
            {(["instagram", "whatsapp", "tiktok", "email"] as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]} only</option>)}
          </Select>
          {count > 500 ? <p className="text-[12px] text-warning">Large batches take a few minutes. You can keep working; progress shows in Outreach.</p> : null}
        </div>
      </Dialog>
    </>
  );
}
