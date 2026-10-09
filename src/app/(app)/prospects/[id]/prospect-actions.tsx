"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { MessageSquarePlus, MessageCircleReply, Ban, Target, Undo2, BadgeCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, ActionButton } from "@/components/ui/dialog";
import { Select, Textarea, Field } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { MESSAGE_ANGLES, CHANNEL_LABELS, type Channel } from "@/server/domain/taxonomy";
import { generateOneAction, logReplyAction, restoreDncAction, manualConversionAction } from "./actions";
import { addToCampaignAction, doNotContactAction } from "../actions";

export function ProspectActions({ prospect, campaigns, canAdmin }: {
  prospect: { id: string; status: string; doNotContact: boolean; isDemo: boolean; signedUp: boolean };
  campaigns: { id: string; name: string }[];
  canAdmin: boolean;
}) {
  const router = useRouter();
  const [dlg, setDlg] = useState<null | "generate" | "reply" | "campaign" | "dnc" | "convert">(null);
  const [pending, start] = useTransition();
  const [channel, setChannel] = useState("auto");
  const [angle, setAngle] = useState("");
  const [campaign, setCampaign] = useState(campaigns[0]?.id ?? "");
  const [replyChannel, setReplyChannel] = useState<Channel>("instagram");
  const [reply, setReply] = useState("");
  const [reason, setReason] = useState("manual");
  const [convType, setConvType] = useState<"signup" | "activated" | "paid">("signup");

  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      if (r.ok) {
        toast(r.message ?? "Done");
        setDlg(null);
        after?.();
        router.refresh();
      } else toast.error(r.error ?? "Failed");
    });

  return (
    <div className="flex flex-wrap gap-1.5">
      {!prospect.doNotContact ? <Button size="sm" variant="primary" onClick={() => setDlg("generate")}><MessageSquarePlus /> Generate message</Button> : null}
      <Button size="sm" onClick={() => setDlg("reply")}><MessageCircleReply /> Log a reply</Button>
      <Button size="sm" onClick={() => setDlg("campaign")} disabled={!campaigns.length}><Target /> Add to campaign</Button>
      {!prospect.signedUp ? <Button size="sm" variant="ghost" onClick={() => setDlg("convert")}><BadgeCheck /> Record conversion</Button> : null}
      {prospect.doNotContact ? (
        canAdmin ? (
          <ActionButton size="sm" variant="ghost" action={() => restoreDncAction(prospect.id)} onDone={() => router.refresh()}
            confirm={{ title: "Restore this prospect?", description: "They'll be removed from the suppression list and can be contacted again. Only do this if they were added by mistake — never after an opt-out." }}>
            <Undo2 /> Restore
          </ActionButton>
        ) : null
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setDlg("dnc")}><Ban /> Do not contact</Button>
      )}

      <Dialog open={dlg === "generate"} onClose={() => setDlg(null)} title="Generate a message" description="The draft is validated and lands in Outreach → Review. Nothing is sent."
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" loading={pending} onClick={() => run(() => generateOneAction(prospect.id, channel, angle || null, null), () => router.push("/outreach"))}>Generate</Button></>}>
        <div className="space-y-3">
          <Field label="Channel">
            <Select value={channel} onChange={(e) => setChannel(e.target.value)}>
              <option value="auto">Best available</option>
              {(["instagram", "whatsapp", "tiktok", "email"] as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
            </Select>
          </Field>
          <Field label="Angle" hint="Default: campaign variant or recommended angle">
            <Select value={angle} onChange={(e) => setAngle(e.target.value)}>
              <option value="">Automatic</option>
              {MESSAGE_ANGLES.map((a) => <option key={a.key} value={a.key}>{a.label} — {a.hint}</option>)}
            </Select>
          </Field>
        </div>
      </Dialog>

      <Dialog open={dlg === "reply"} onClose={() => setDlg(null)} title="Log a reply" description="Paste what they sent. It's classified automatically; opt-outs are suppressed immediately."
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" loading={pending} onClick={() => run(() => logReplyAction(prospect.id, replyChannel, reply), () => setReply(""))}>Log reply</Button></>}>
        <div className="space-y-3">
          <Field label="Channel">
            <Select value={replyChannel} onChange={(e) => setReplyChannel(e.target.value as Channel)}>
              {(["instagram", "whatsapp", "tiktok", "email"] as Channel[]).map((c) => <option key={c} value={c}>{CHANNEL_LABELS[c]}</option>)}
            </Select>
          </Field>
          <Textarea autoFocus value={reply} onChange={(e) => setReply(e.target.value)} placeholder="e.g. This looks interesting, how much is it?" className="min-h-24" />
        </div>
      </Dialog>

      <Dialog open={dlg === "campaign"} onClose={() => setDlg(null)} title="Add to campaign"
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" loading={pending} onClick={() => run(() => addToCampaignAction({ ids: [prospect.id] }, campaign))}>Add</Button></>}>
        <Select value={campaign} onChange={(e) => setCampaign(e.target.value)}>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
      </Dialog>

      <Dialog open={dlg === "dnc"} onClose={() => setDlg(null)} title="Do not contact" description="Suppresses every handle, number and email for this business, cancels follow-ups and blocks unsent drafts."
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="danger" loading={pending} onClick={() => run(() => doNotContactAction({ ids: [prospect.id] }, reason))}>Confirm</Button></>}>
        <Select value={reason} onChange={(e) => setReason(e.target.value)}>
          <option value="manual">Manual blacklist</option>
          <option value="opt_out">Asked not to be contacted</option>
          <option value="customer">Already a customer</option>
          <option value="competitor">Competitor</option>
          <option value="invalid">Invalid business</option>
          <option value="closed">Closed business</option>
          <option value="inappropriate">Inappropriate</option>
        </Select>
      </Dialog>

      <Dialog open={dlg === "convert"} onClose={() => setDlg(null)} title="Record a conversion manually" description="Use when a signup couldn't be matched automatically (e.g. they signed up with a different email)."
        footer={<><Button variant="ghost" onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" loading={pending} onClick={() => run(() => manualConversionAction(prospect.id, convType))}>Record</Button></>}>
        <Select value={convType} onChange={(e) => setConvType(e.target.value as typeof convType)}>
          <option value="signup">Signed up</option>
          <option value="activated">Activated</option>
          <option value="paid">Paid</option>
        </Select>
      </Dialog>
    </div>
  );
}
