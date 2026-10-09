"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CheckCircle2, AlertCircle, Loader2, XCircle } from "lucide-react";
import { Progress } from "./ui/display";
import { fmtNum } from "@/lib/utils";

interface JobState {
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  progress_current: number;
  progress_total: number | null;
  progress_label: string | null;
  last_error: string | null;
  attempts: number;
  max_attempts: number;
}

/** Live progress for a background job; refreshes the page when it finishes. */
export function JobProgress({ jobId, title, doneHref, onDone }: { jobId: string | null; title: string; doneHref?: string; onDone?: () => void }) {
  const router = useRouter();
  const [job, setJob] = useState<JobState | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    let refreshed = 0;
    const tick = async () => {
      try {
        const res = await fetch(`/api/jobs/${jobId}`, { cache: "no-store" });
        if (res.ok) {
          const j = (await res.json()) as JobState;
          setJob(j);
          if (["succeeded", "failed", "cancelled"].includes(j.status)) {
            onDone?.();
            router.refresh();
            return;
          }
          // Refresh the list every ~10s while running so drafts appear progressively.
          if (Date.now() - refreshed > 10_000) {
            refreshed = Date.now();
            router.refresh();
          }
        }
      } catch {
        /* retry */
      }
      if (!stop) setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const pct = job?.progress_total ? (job.progress_current / job.progress_total) * 100 : 0;
  const icon =
    !job || job.status === "running" || job.status === "queued" ? <Loader2 className="size-4 animate-spin text-fg-3" /> :
    job.status === "succeeded" ? <CheckCircle2 className="size-4 text-success" /> :
    job.status === "cancelled" ? <XCircle className="size-4 text-fg-3" /> : <AlertCircle className="size-4 text-danger" />;
  return (
    <div>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[13px] font-medium">{title}</span>
        <span className="ml-auto text-[12px] tabular text-fg-3">
          {job?.progress_total ? `${fmtNum(job.progress_current)} / ${fmtNum(job.progress_total)} · ${pct.toFixed(1)}%` : job?.status === "queued" ? "Queued" : ""}
        </span>
      </div>
      <Progress value={job?.status === "succeeded" ? 100 : pct} className="mt-2" tone={job?.status === "failed" ? "danger" : job?.status === "succeeded" ? "success" : "accent"} />
      <div className="mt-1.5 flex justify-between text-[11.5px] text-fg-3">
        <span>{job?.status === "failed" ? `Failed: ${job.last_error ?? "unknown error"}` : job?.progress_label ?? "Starting…"}</span>
        {job?.status === "succeeded" && doneHref ? <Link href={doneHref} className="text-fg underline">View results</Link> : null}
        {job && job.attempts > 1 && job.status !== "succeeded" ? <span>Attempt {job.attempts}/{job.max_attempts}</span> : null}
      </div>
    </div>
  );
}
