"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { GitMerge, Split, EyeOff, ScanSearch, CheckCheck } from "lucide-react";
import { Panel, Badge, EmptyState, ScoreBadge } from "@/components/ui/display";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { StatusBadge } from "@/components/ui/status";
import { categoryLabel } from "@/server/domain/taxonomy";
import { resolveDuplicateAction, scanDuplicatesAction } from "./actions";

interface Side { id: string; business_name: string; city: string | null; category: string | null; instagram_handle: string | null; phone: string | null; source: string; icp_score: number | null; status: string; contact_count: number }
export interface DuplicatePair { id: string; confidence: number; reasons: { reasons: string[]; conflicts: string[] }; a: Side; b: Side }

export function DuplicateList({ pairs, canEdit }: { pairs: DuplicatePair[]; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (id: string, d: "merge" | "kept_separate" | "ignored", keep?: string) =>
    start(async () => {
      const r = await resolveDuplicateAction(id, d, keep);
      if (r.ok) toast(r.message ?? "Done");
      else toast.error(r.error);
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-[12.5px] text-fg-3">The same business can appear on Instagram, OpenStreetMap and your CSVs. Uncertain matches wait here — nothing is merged without you.</p>
        {canEdit ? <Button size="sm" onClick={() => start(async () => { const r = await scanDuplicatesAction(); toast(r.ok ? r.message ?? "" : r.error); })}><ScanSearch /> Scan for duplicates</Button> : null}
      </div>
      {pairs.length === 0 ? <Panel><EmptyState icon={<CheckCheck />} title="No possible duplicates" description="New matches show up here as prospects are discovered or imported." /></Panel> : null}
      {pairs.map((p) => (
        <Panel key={p.id} padded={false}>
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <Badge tone={p.confidence >= 75 ? "warning" : "neutral"}>{p.confidence}% likely the same</Badge>
            <span className="text-[12px] text-fg-2">{p.reasons.reasons.join(" · ")}</span>
            {p.reasons.conflicts.length ? <span className="text-[12px] text-danger">Conflicts: {p.reasons.conflicts.join(" · ")}</span> : null}
          </div>
          <div className="grid gap-px bg-border md:grid-cols-2">
            {[p.a, p.b].map((s) => (
              <div key={s.id} className="bg-surface p-4">
                <div className="flex items-center gap-2"><Link href={`/prospects/${s.id}`} className="font-medium hover:underline">{s.business_name}</Link><ScoreBadge score={s.icp_score} /><StatusBadge status={s.status} /></div>
                <p className="mt-1 text-[12px] text-fg-3">{categoryLabel(s.category)} · {s.city ?? "—"} · {s.instagram_handle ? `@${s.instagram_handle}` : "no IG"} · {s.phone ?? "no phone"}</p>
                <p className="text-[11.5px] text-fg-3">Source: {s.source.replace(/_/g, " ")} · contacted {s.contact_count}×</p>
                {canEdit ? <Button size="xs" className="mt-2" loading={pending} onClick={() => act(p.id, "merge", s.id)}><GitMerge /> Merge, keep this one</Button> : null}
              </div>
            ))}
          </div>
          {canEdit ? (
            <div className="flex gap-1.5 border-t border-border px-4 py-2">
              <Button size="xs" variant="ghost" onClick={() => act(p.id, "kept_separate")}><Split /> Different businesses</Button>
              <Button size="xs" variant="ghost" onClick={() => act(p.id, "ignored")}><EyeOff /> Ignore</Button>
            </div>
          ) : null}
        </Panel>
      ))}
    </div>
  );
}
