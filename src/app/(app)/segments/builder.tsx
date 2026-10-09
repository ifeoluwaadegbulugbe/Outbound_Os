"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { Panel } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { toast } from "@/components/ui/toast";
import type { FilterNode } from "@/server/domain/filters";
import { encodeJson } from "@/lib/filter-codec";
import { previewSegmentAction, saveSegmentAction } from "./actions";

export function SegmentBuilder() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<{ filter: FilterNode; description: string; count: number; unparsed: string[] } | null>(null);
  const [pending, start] = useTransition();
  return (
    <Panel title={<span className="inline-flex items-center gap-1.5"><Sparkles className="size-3.5 text-accent" /> New segment</span>}>
      <div className="flex flex-wrap gap-2">
        <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text.trim() && start(async () => {
          const r = await previewSegmentAction(text); if (r.ok) { setPreview(r); setName(text.slice(0, 60)); } else toast.error(r.error);
        })} placeholder="Beauty businesses in Lagos with more than 2,000 followers that accept bookings" className="min-w-[260px] flex-1" />
        <Button loading={pending} disabled={!text.trim()} onClick={() => start(async () => {
          const r = await previewSegmentAction(text); if (r.ok) { setPreview(r); setName(text.slice(0, 60)); } else toast.error(r.error);
        })}>Preview</Button>
      </div>
      {preview ? (
        <div className="mt-3 space-y-2 rounded-md bg-surface-2 p-3 text-[12.5px]">
          <p><span className="font-mono text-[12px]">{preview.description}</span></p>
          <p><b className="tabular">{preview.count.toLocaleString()}</b> prospects match · <Link className="underline" href={`/prospects?f=${encodeJson(preview.filter)}`}>view them</Link>{preview.unparsed.length ? <span className="text-warning"> · ignored: {preview.unparsed.join(", ")}</span> : null}</p>
          <div className="flex flex-wrap gap-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Segment name" className="w-72" />
            <Button variant="primary" loading={pending} disabled={!name.trim()} onClick={() => start(async () => {
              const r = await saveSegmentAction(name, text, preview.filter);
              if (r.ok) { toast(r.message ?? "Saved"); setPreview(null); setText(""); router.refresh(); } else toast.error(r.error);
            })}>Save segment</Button>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}
