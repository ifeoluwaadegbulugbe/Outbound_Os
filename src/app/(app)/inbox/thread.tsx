"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Sparkles, Send, RefreshCw, ExternalLink, MessageCircleReply, Archive, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/display";
import { Select, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { IntentBadge } from "@/components/ui/status";
import { openUrl } from "@/server/domain/channels";
import type { Channel } from "@/server/domain/taxonomy";
import { cn, fmtDateTime } from "@/lib/utils";
import { suggestReplyAction, sendReplyAction, logInboundAction, setConversationStatusAction } from "./actions";

interface Conv {
  id: string; prospect_id: string; channel: string; status: string; intent: string | null; intent_confidence: number | null; summary: string | null; next_action: string | null;
  business_name: string; instagram_handle: string | null; tiktok_handle: string | null; whatsapp: string | null; phone: string | null; email: string | null; is_demo: boolean; do_not_contact: boolean;
}

const TONES = ["Warm and casual", "Short and direct", "Friendly but professional", "Very brief"];

export function Thread({ conversation: c, messages, canEdit }: { conversation: Conv; messages: { id: string; direction: "inbound" | "outbound"; body: string; occurred_at: Date; classification: { intent?: string; confidence?: number } | null }[]; canEdit: boolean }) {
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [source, setSource] = useState<string | null>(null);
  const [tone, setTone] = useState(TONES[0]);
  const [inbound, setInbound] = useState("");
  const [pending, start] = useTransition();
  const lastInbound = [...messages].reverse().find((m) => m.direction === "inbound");
  const awaitingUs = messages.at(-1)?.direction === "inbound";

  const suggest = (t?: string) =>
    start(async () => {
      const r = await suggestReplyAction(c.id, t ?? tone);
      if (r.ok) { setDraft(r.body); setSource(r.source); } else toast.error(r.error);
    });

  useEffect(() => {
    setDraft("");
    setSource(null);
    if (canEdit && awaitingUs && !c.do_not_contact && c.intent !== "opt_out") suggest();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);

  const open = async () => {
    if (c.is_demo) return toast.info("Demo prospect", "Nothing opened — this is fictional demo data.");
    const url = openUrl(c.channel as Channel, c, draft);
    try { await navigator.clipboard.writeText(draft); } catch { /* ignore */ }
    if (url) window.open(url, "_blank", "noopener");
    toast("Reply copied", { kind: "info", description: c.channel === "whatsapp" ? "WhatsApp opened with your reply typed in." : "Paste it in the conversation and send, then mark it sent here." });
  };

  return (
    <div className="grid lg:grid-cols-[1fr_280px]">
      <div className="min-w-0 border-border lg:border-r">
        <div className="max-h-[52vh] space-y-2.5 overflow-y-auto p-4">
          {messages.map((m) => (
            <div key={m.id} className={cn("max-w-[85%]", m.direction === "outbound" && "ml-auto")}>
              <div className={cn("rounded-lg px-3 py-2 text-[13px]", m.direction === "outbound" ? "bg-surface-3" : "bg-accent-subtle")}>
                <p className="whitespace-pre-wrap">{m.body}</p>
              </div>
              <p className={cn("mt-0.5 flex items-center gap-1.5 text-[10.5px] text-fg-3", m.direction === "outbound" && "justify-end")}>
                {m.direction === "outbound" ? "You" : c.business_name} · {fmtDateTime(m.occurred_at)}
                {m.classification?.intent ? <IntentBadge intent={m.classification.intent} /> : null}
              </p>
            </div>
          ))}
        </div>
        {canEdit && !c.do_not_contact ? (
          <div className="border-t border-border p-4">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 text-[12px] font-medium"><Sparkles className="size-3.5 text-accent" /> Suggested reply</span>
              {source ? <Badge>{source === "template" ? "Template" : `AI · ${source.replace("ai:", "").split("/")[0]}`}</Badge> : null}
              <Select value={tone} onChange={(e) => { setTone(e.target.value); suggest(e.target.value); }} className="ml-auto h-7 w-auto text-[12px]" aria-label="Tone">
                {TONES.map((t) => <option key={t}>{t}</option>)}
              </Select>
              <Button size="xs" variant="ghost" onClick={() => suggest()} loading={pending}><RefreshCw /> Regenerate</Button>
            </div>
            <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} className="min-h-24" placeholder={pending ? "Drafting…" : "Write a reply…"} aria-label="Reply" />
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Button size="sm" variant="primary" onClick={open} disabled={!draft.trim()}><ExternalLink /> Copy & open {c.channel}</Button>
              <Button size="sm" onClick={() => start(async () => { const r = await sendReplyAction(c.id, draft); if (r.ok) { toast(r.message ?? "Logged"); setDraft(""); router.refresh(); } else toast.error(r.error); })} disabled={!draft.trim()} loading={pending}><Send /> Mark sent</Button>
              <Button size="sm" variant="ghost" onClick={async () => { await navigator.clipboard.writeText(draft); toast("Copied"); }} disabled={!draft.trim()}><Copy /> Copy</Button>
            </div>
            <p className="mt-1.5 text-[11.5px] text-fg-3">Nothing is sent automatically. Send it in the app, then mark it sent.</p>
          </div>
        ) : c.do_not_contact ? <p className="border-t border-border p-4 text-[12.5px] text-danger">This prospect opted out or is on the do-not-contact list. Replying is disabled.</p> : null}
      </div>
      <aside className="space-y-4 p-4">
        <div>
          <p className="text-[11.5px] font-medium uppercase tracking-wide text-fg-3">AI summary</p>
          <p className="mt-1 text-[12.5px]">{c.summary ?? "—"}</p>
          {c.intent ? <p className="mt-1.5 flex items-center gap-1.5 text-[12px] text-fg-3"><IntentBadge intent={c.intent} /> {c.intent_confidence}% confident</p> : null}
        </div>
        <div>
          <p className="text-[11.5px] font-medium uppercase tracking-wide text-fg-3">Recommended next action</p>
          <p className="mt-1 text-[12.5px]">{c.next_action ?? "—"}</p>
        </div>
        {lastInbound ? <p className="text-[11.5px] text-fg-3">Last reply {fmtDateTime(lastInbound.occurred_at)}</p> : null}
        {canEdit ? (
          <div className="border-t border-border pt-4">
            <p className="mb-1.5 flex items-center gap-1 text-[12px] font-medium"><MessageCircleReply className="size-3.5" /> They replied again?</p>
            <Textarea value={inbound} onChange={(e) => setInbound(e.target.value)} className="min-h-16 text-[12.5px]" placeholder="Paste their message" />
            <Button size="xs" className="mt-1.5" disabled={!inbound.trim()} loading={pending} onClick={() => start(async () => {
              const r = await logInboundAction(c.id, inbound);
              if (r.ok) { toast(r.message ?? "Logged"); setInbound(""); router.refresh(); } else toast.error(r.error);
            })}>Log reply</Button>
          </div>
        ) : null}
        {canEdit && c.status !== "closed" ? (
          <Button size="xs" variant="ghost" onClick={() => start(async () => { await setConversationStatusAction(c.id, "closed"); router.refresh(); })}><Archive /> Close conversation</Button>
        ) : null}
      </aside>
    </div>
  );
}
