"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState, useTransition } from "react";
import { ExternalLink, Check, SkipForward, Copy, Puzzle, ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge, Kbd, ScoreBadge, Progress } from "@/components/ui/display";
import { Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { CHANNEL_SPECS, openUrl } from "@/server/domain/channels";
import { categoryLabel, CHANNEL_LABELS, type Channel } from "@/server/domain/taxonomy";
import type { SenderUsage } from "@/server/services/outreach";
import { editMessageAction, markSentAction, rejectAction } from "./actions";
import type { ReviewItem } from "./review-list";

export interface SendItem extends ReviewItem {
  whatsapp: string | null;
  phone: string | null;
  email: string | null;
  priority_score: number | null;
  scheduled_for: Date | null;
}

/** Whether the companion browser extension is installed (it sets this attribute). */
function extensionPresent(): boolean {
  return typeof document !== "undefined" && document.documentElement.dataset.obExtension === "1";
}

/**
 * Sending session: one prospect at a time. Enter opens the conversation
 * pre-filled (WhatsApp/email natively; Instagram/TikTok via the extension or
 * clipboard). The human presses Send in the app, then S here.
 */
export function SendSession({ items, usage }: { items: SendItem[]; usage: SenderUsage[] }) {
  const router = useRouter();
  const [idx, setIdx] = useState(0);
  const [done, setDone] = useState<Set<string>>(new Set());
  const [opened, setOpened] = useState(false);
  const [pending, start] = useTransition();
  const [hasExt, setHasExt] = useState(false);
  const queue = items.filter((i) => !done.has(i.id));
  const item = queue[Math.min(idx, queue.length - 1)];
  const [body, setBody] = useState(item?.body ?? "");

  // The extension can connect after the page loads (e.g. right after it's reloaded), so keep checking.
  useEffect(() => {
    setHasExt(extensionPresent());
    const t = setInterval(() => setHasExt(extensionPresent()), 2000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    setBody(item?.body ?? "");
    setOpened(false);
  }, [item?.id, item?.body]);

  const channelUsage = item ? usage.filter((u) => u.channel === item.channel) : [];
  const capLeft = channelUsage.reduce((a, u) => a + Math.max(0, u.cap - u.sentToday), 0);

  const ensureSaved = async () => {
    if (!item || body === item.body) return true;
    const r = await editMessageAction(item.id, body, item.subject);
    if (!r.ok || !r.validation.ok) {
      toast.error(r.ok ? r.validation.issues.find((i) => i.severity === "block")?.message ?? "Blocked" : r.error);
      return false;
    }
    return true;
  };

  const open = useCallback(async () => {
    if (!item) return;
    if (!(await ensureSaved())) return;
    if (item.is_demo) {
      toast.info("Demo prospect", "This is fictional demo data, so nothing was opened. Mark it sent to try the flow.");
      setOpened(true);
      return;
    }
    const url = openUrl(item.channel, item, body, item.subject);
    if (!url) return toast.error(`No ${CHANNEL_LABELS[item.channel]} contact`);
    const spec = CHANNEL_SPECS[item.channel];
    if (spec.prefill === "extension") {
      if (hasExt) {
        window.postMessage({ type: "OB_OPEN_CONVERSATION", channel: item.channel, url, text: body, messageId: item.id, handle: item.instagram_handle ?? item.tiktok_handle }, window.location.origin);
        toast("Opening with your message filled in", { kind: "info", description: "Press Send in the tab, then come back and press S." });
      } else {
        try {
          await navigator.clipboard.writeText(body);
        } catch {
          /* clipboard blocked */
        }
        window.open(url, "_blank", "noopener");
        toast("Message copied — paste it and send", { kind: "info", description: "Install the browser extension to have it filled in automatically." });
      }
    } else {
      window.open(url, "_blank", "noopener");
    }
    setOpened(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, body, hasExt]);

  const markSent = useCallback(() => {
    if (!item) return;
    start(async () => {
      if (!(await ensureSaved())) return;
      const r = await markSentAction(item.id);
      if (r.ok) {
        setDone((d) => new Set(d).add(item.id));
        toast(`Sent to ${item.business_name}`);
        router.refresh();
      } else toast.error(r.error);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, body]);

  const skip = useCallback(() => {
    if (!item) return;
    start(async () => {
      const r = await rejectAction([item.id], "skipped");
      if (r.ok) setDone((d) => new Set(d).add(item.id));
      else toast.error(r.error);
    });
  }, [item]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" || e.key === "o") { e.preventDefault(); void open(); }
      else if (e.key === "s") { e.preventDefault(); markSent(); }
      else if (e.key === "k") { e.preventDefault(); skip(); }
      else if (e.key === "ArrowRight") setIdx((i) => Math.min(queue.length - 1, i + 1));
      else if (e.key === "ArrowLeft") setIdx((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, markSent, skip, queue.length]);

  if (!item) {
    return (
      <div className="rounded-lg border border-border bg-surface p-10 text-center shadow-sm">
        <Check className="mx-auto size-8 text-success" />
        <p className="mt-2 text-[15px] font-semibold">Queue cleared — {done.size} sent or skipped this session</p>
        <p className="text-[12.5px] text-fg-3">Follow-ups are scheduled automatically. Replies go to the Inbox.</p>
        <div className="mt-4 flex justify-center gap-2"><Link href="/inbox" className="text-[13px] underline">Open inbox</Link></div>
      </div>
    );
  }

  const spec = CHANNEL_SPECS[item.channel];
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_280px]">
      <article className="rounded-lg border border-border bg-surface shadow-sm">
        <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
          <Link href={`/prospects/${item.prospect_id}`} className="text-[15px] font-semibold hover:underline">{item.business_name}</Link>
          <ScoreBadge score={item.icp_score} />
          {item.is_demo ? <Badge>demo</Badge> : null}
          <span className="text-[12px] text-fg-3">{categoryLabel(item.category)}{item.city ? ` · ${item.city}` : ""}</span>
          <span className="ml-auto flex items-center gap-1 text-[12px] text-fg-3">
            <button aria-label="Previous" onClick={() => setIdx((i) => Math.max(0, i - 1))} className="rounded p-1 hover:bg-surface-2"><ChevronLeft className="size-4" /></button>
            <span className="tabular">{Math.min(idx, queue.length - 1) + 1} / {queue.length}</span>
            <button aria-label="Next" onClick={() => setIdx((i) => Math.min(queue.length - 1, i + 1))} className="rounded p-1 hover:bg-surface-2"><ChevronRight className="size-4" /></button>
          </span>
        </header>
        <div className="space-y-3 p-5">
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <Badge tone="info">{spec.label}</Badge>
            <span className="text-fg-2">
              {item.channel === "instagram" && item.instagram_handle ? `@${item.instagram_handle}` : item.channel === "tiktok" && item.tiktok_handle ? `@${item.tiktok_handle}` : item.channel === "whatsapp" ? item.whatsapp ?? item.phone : item.email}
            </span>
            <span className="text-fg-3">· {item.kind === "followup" ? `Follow-up ${item.step}` : "First message"}</span>
          </div>
          <Textarea value={body} onChange={(e) => setBody(e.target.value)} className="min-h-36 text-[14px] leading-relaxed" aria-label="Message to send" />
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={() => void open()} kbd="↵">
              <ExternalLink /> {spec.prefill === "url" ? `Open ${spec.label} (pre-filled)` : hasExt ? `Open ${spec.label} & fill` : `Copy & open ${spec.label}`}
            </Button>
            <Button onClick={markSent} loading={pending} kbd="S" variant={opened ? "primary" : "secondary"}><Check /> Mark sent</Button>
            <Button variant="ghost" onClick={skip} kbd="K"><SkipForward /> Skip</Button>
            <Button variant="ghost" onClick={async () => { await navigator.clipboard.writeText(body); toast("Copied"); }}><Copy /> Copy</Button>
          </div>
          <p className="text-[12px] text-fg-3">{spec.note}</p>
        </div>
      </article>

      <aside className="space-y-3">
        <div className="rounded-lg border border-border bg-surface p-4 shadow-sm">
          <p className="text-[12px] font-medium text-fg-3">Today on {spec.label}</p>
          {channelUsage.length ? channelUsage.map((u) => (
            <div key={u.id} className="mt-2">
              <div className="flex justify-between text-[12px]"><span className="truncate">{u.label}</span><span className="tabular">{u.sentToday}/{u.cap}</span></div>
              <Progress value={u.sentToday} max={u.cap} className="mt-1" tone={u.sentToday >= u.cap ? "danger" : "success"} />
            </div>
          )) : <p className="mt-1 text-[12px] text-fg-3">No {spec.label} sender account set up — caps aren&apos;t enforced. <Link href="/settings/senders" className="underline">Add one</Link></p>}
          {channelUsage.length && capLeft === 0 ? <p className="mt-2 text-[12px] text-danger">Daily cap reached. Continue tomorrow to protect the account.</p> : null}
        </div>
        {spec.prefill === "extension" && !hasExt ? (
          <div className="rounded-lg border border-border bg-surface p-4 text-[12.5px] shadow-sm">
            <p className="flex items-center gap-1.5 font-medium text-warning"><Puzzle className="size-4" /> Extension not connected to this page</p>
            <p className="mt-1 text-fg-3">Without it, the message is copied for you to paste (Ctrl+V) in the chat. To have it typed in automatically:</p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-fg-3">
              <li>Right-click the extension icon → <b>Options</b> → <b>Save &amp; test</b>.</li>
              <li>Refresh this page.</li>
            </ol>
            <Link href="/integrations#browser_extension" className="mt-2 inline-block underline">Not installed yet? Set it up</Link>
          </div>
        ) : null}
        <div className="rounded-lg border border-border bg-surface p-4 text-[12px] text-fg-3 shadow-sm">
          <p className="mb-1.5 font-medium text-fg-2">Shortcuts</p>
          <p className="flex items-center gap-1.5"><Kbd>↵</Kbd> open conversation</p>
          <p className="mt-1 flex items-center gap-1.5"><Kbd>S</Kbd> mark sent & next</p>
          <p className="mt-1 flex items-center gap-1.5"><Kbd>K</Kbd> skip</p>
          <p className="mt-1 flex items-center gap-1.5"><Kbd>←</Kbd><Kbd>→</Kbd> browse</p>
        </div>
      </aside>
    </div>
  );
}
