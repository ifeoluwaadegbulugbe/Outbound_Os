"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pause, Play, Pencil, UserPlus, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionButton, Dialog } from "@/components/ui/dialog";
import { Field, Input, Textarea, Checkbox } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { setCampaignStatusAction, updateCampaignAction, addMatchingAction } from "../actions";

export function CampaignControls({ campaign }: { campaign: { id: string; status: string; instructions: string | null; tone: string | null; offer: string | null; constraints: Record<string, unknown> } }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [instructions, setInstructions] = useState(campaign.instructions ?? "");
  const [tone, setTone] = useState(campaign.tone ?? "");
  const [offer, setOffer] = useState(campaign.offer ?? "");
  const [maxChars, setMaxChars] = useState(String(campaign.constraints?.maxChars ?? ""));
  const [noEmojis, setNoEmojis] = useState(Boolean(campaign.constraints?.noEmojis));
  const [pending, start] = useTransition();
  const done = () => router.refresh();

  return (
    <div className="flex flex-wrap gap-1.5">
      {campaign.status === "active" ? (
        <ActionButton size="sm" action={() => setCampaignStatusAction(campaign.id, "paused")} onDone={done}
          confirm={{ title: "Pause this campaign?", description: "Approved-but-unsent messages go back to review. Follow-ups won't be drafted for paused campaigns until you resume." }}><Pause /> Pause</ActionButton>
      ) : campaign.status !== "completed" ? (
        <ActionButton size="sm" variant="primary" action={() => setCampaignStatusAction(campaign.id, "active")} onDone={done}><Play /> Activate</ActionButton>
      ) : null}
      <Button size="sm" onClick={() => setEditing(true)}><Pencil /> Edit messaging</Button>
      <ActionButton size="sm" action={() => addMatchingAction(campaign.id, 60)} onDone={done}><UserPlus /> Add matching prospects</ActionButton>
      {campaign.status !== "completed" ? (
        <ActionButton size="sm" variant="ghost" action={() => setCampaignStatusAction(campaign.id, "completed")} onDone={done}
          confirm={{ title: "Mark campaign complete?", description: "It stays in analytics. You can't draft new messages for it." }}><CheckCircle2 /> Complete</ActionButton>
      ) : null}
      <Dialog open={editing} onClose={() => setEditing(false)} title="Edit messaging" description="Applies to messages drafted from now on." wide
        footer={<><Button variant="ghost" onClick={() => setEditing(false)}>Cancel</Button><Button variant="primary" loading={pending} onClick={() => start(async () => {
          const r = await updateCampaignAction(campaign.id, { instructions, tone, offer, constraints: { maxChars: maxChars ? Number(maxChars) : undefined, noEmojis } });
          if (r.ok) { toast(r.message ?? "Saved"); setEditing(false); done(); } else toast.error(r.error);
        })}>Save</Button></>}>
        <div className="space-y-3">
          <Field label="Instructions for the AI"><Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} className="min-h-24" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Tone"><Input value={tone} onChange={(e) => setTone(e.target.value)} /></Field>
            <Field label="Offer"><Input value={offer} onChange={(e) => setOffer(e.target.value)} /></Field>
            <Field label="Max characters"><Input type="number" value={maxChars} onChange={(e) => setMaxChars(e.target.value)} /></Field>
            <label className="flex items-center gap-2 pt-6 text-[12.5px]"><Checkbox checked={noEmojis} onChange={(e) => setNoEmojis(e.target.checked)} /> No emojis</label>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
