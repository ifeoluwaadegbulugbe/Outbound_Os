"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Plus, Bookmark, Check } from "lucide-react";
import { Panel } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import { CATEGORIES } from "@/server/domain/taxonomy";
import { captureAction } from "./actions";

/**
 * Quick capture for profiles a human finds while browsing. The bookmarklet
 * only sends the current page's URL, title and whatever text the user has
 * highlighted — it doesn't read or crawl the page.
 */
export function CaptureForm({ campaigns, bookmarkletBase, initial }: { campaigns: { id: string; name: string }[]; bookmarkletBase: string; initial: { url: string; text: string; name: string } }) {
  const [url, setUrl] = useState(initial.url);
  const [text, setText] = useState(initial.text);
  const [name, setName] = useState(initial.name.replace(/\s*[•|(].*$/, "").replace(/ on (Instagram|TikTok).*$/i, ""));
  const [category, setCategory] = useState("");
  const [campaign, setCampaign] = useState(campaigns[0]?.id ?? "");
  const [recent, setRecent] = useState<{ id: string; name: string; outcome: string }[]>([]);
  const [pending, start] = useTransition();

  const bookmarklet = `javascript:(()=>{const s=String(window.getSelection()||'').slice(0,2000);window.open('${bookmarkletBase}/discover?tab=capture&url='+encodeURIComponent(location.href)+'&title='+encodeURIComponent(document.title)+'&text='+encodeURIComponent(s),'_blank')})()`;

  const submit = () =>
    start(async () => {
      const r = await captureAction({ url, text, name, category, campaignId: campaign || null });
      if (!r.ok) return toast.error(r.error);
      const d = r.data as { prospectId: string; outcome: string };
      toast(r.message ?? "Added");
      setRecent((x) => [{ id: d.prospectId, name: name || url, outcome: d.outcome }, ...x].slice(0, 8));
      setUrl("");
      setText("");
      setName("");
    });

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_340px]">
      <Panel title="Add a profile you found" description="Paste the profile link and their bio. Handles, phone numbers, booking links and signals are extracted automatically.">
        <div className="space-y-3">
          <Field label="Profile link" htmlFor="cap-url"><Input id="cap-url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.instagram.com/handle/ or https://www.tiktok.com/@handle" autoFocus /></Field>
          <Field label="Business name" htmlFor="cap-name" hint="Optional — taken from the bio or handle"><Input id="cap-name" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Bio / description" htmlFor="cap-text" hint="Copy it from the profile"><Textarea id="cap-text" value={text} onChange={(e) => setText(e.target.value)} className="min-h-28" placeholder="Lagos nail tech 💅 Acrylics & gel · DM to book · WhatsApp 0803…" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Category" hint="Auto-detected if empty">
              <Select value={category} onChange={(e) => setCategory(e.target.value)}>
                <option value="">Detect automatically</option>
                {CATEGORIES.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
              </Select>
            </Field>
            <Field label="Add to campaign">
              <Select value={campaign} onChange={(e) => setCampaign(e.target.value)}><option value="">None</option>{campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
            </Field>
          </div>
          <Button variant="primary" onClick={submit} loading={pending} disabled={!url.trim() && !text.trim()}><Plus /> Add prospect</Button>
        </div>
      </Panel>
      <div className="space-y-4">
        <Panel title={<span className="inline-flex items-center gap-1.5"><Bookmark className="size-3.5" /> One-click capture</span>}>
          <p className="text-[12.5px] text-fg-2">Drag this button to your bookmarks bar. On any profile, highlight the bio and click it — this form opens pre-filled.</p>
          <a href={bookmarklet} onClick={(e) => e.preventDefault()} draggable className="mt-3 inline-flex h-8 cursor-grab items-center gap-1.5 rounded-md border border-border bg-surface-2 px-3 text-[12.5px] font-medium">
            <Bookmark className="size-3.5" /> Add to Outbound
          </a>
          <p className="mt-2 text-[11.5px] text-fg-3">It only sends the page link, title and the text you highlighted. Nothing is read automatically.</p>
        </Panel>
        {recent.length ? (
          <Panel title="Added this session">
            <ul className="space-y-1.5 text-[12.5px]">{recent.map((r) => (
              <li key={r.id} className="flex items-center gap-2"><Check className="size-3.5 text-success" /><Link href={`/prospects/${r.id}`} className="truncate hover:underline">{r.name}</Link><span className="ml-auto text-[11px] text-fg-3">{r.outcome}</span></li>
            ))}</ul>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
