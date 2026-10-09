"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Pause, Play, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { controlDiscoveryAction } from "./actions";

export function RunControls({ runId, status }: { runId: string; status: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const act = (op: "pause" | "resume" | "cancel") => start(async () => {
    const r = await controlDiscoveryAction(runId, op);
    if (r.ok) { toast(r.message ?? "Done"); router.refresh(); } else toast.error(r.error);
  });
  const live = status === "queued" || status === "running";
  const resumable = status === "paused" || status === "failed" || status === "cancelled";
  return (
    <span className="inline-flex gap-1">
      {live ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => act("pause")}><Pause /> Pause</Button> : null}
      {resumable ? <Button size="sm" variant="secondary" disabled={pending} onClick={() => act("resume")}><Play /> Resume</Button> : null}
      {live || status === "paused" ? <Button size="sm" variant="ghost" disabled={pending} onClick={() => act("cancel")}><X /> Cancel</Button> : null}
    </span>
  );
}
