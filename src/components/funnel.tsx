import Link from "next/link";
import { FUNNEL_STAGES, type Funnel } from "@/server/domain/funnel";
import { cn, fmtNum } from "@/lib/utils";

/**
 * Horizontal funnel. Bar widths are relative to the first stage; the small
 * figure between rows is the stage-to-stage conversion. Every stage links to
 * the underlying prospects.
 */
export function FunnelChart({ data, hrefFor, compact, stages = FUNNEL_STAGES, successFrom = 5, accentFrom = 3 }: {
  data: Funnel | Record<string, number>; hrefFor: (stage: string) => string; compact?: boolean;
  /** Custom stage list (e.g. the email funnel); defaults to the prospect funnel. */
  stages?: readonly { key: string; label: string }[]; successFrom?: number; accentFrom?: number;
}) {
  const d = data as Record<string, number>;
  const top = Math.max(1, d[stages[0].key] ?? 0);
  return (
    <ol className="space-y-1">
      {stages.map((s, i) => {
        const v = d[s.key] ?? 0;
        const prev = i > 0 ? d[stages[i - 1].key] ?? 0 : null;
        const conv = prev ? v / prev : null;
        const w = Math.max(v > 0 ? 1.5 : 0, (v / top) * 100);
        return (
          <li key={s.key}>
            <Link href={hrefFor(s.key)} className="group grid grid-cols-[96px_1fr_auto] items-center gap-3 rounded-md px-1.5 py-1 hover:bg-surface-2 sm:grid-cols-[136px_1fr_150px]">
              <span className="truncate text-[12.5px] text-fg-2 group-hover:text-fg">{s.label}</span>
              <span className={cn("relative block overflow-hidden rounded bg-surface-2", compact ? "h-4" : "h-5")}>
                <span
                  className={cn("absolute inset-y-0 left-0 rounded transition-[width] duration-700", i >= successFrom ? "bg-success/80" : i >= accentFrom ? "bg-accent/80" : "bg-fg/70")}
                  style={{ width: `${w}%` }}
                />
              </span>
              <span className="flex items-baseline justify-end gap-2 tabular">
                <span className="text-[13px] font-semibold text-fg">{fmtNum(v)}</span>
                <span className="hidden w-14 text-right text-[11.5px] text-fg-3 sm:inline" title={prev != null ? `${fmtNum(v)} of ${fmtNum(prev)} from the previous stage` : undefined}>
                  {conv == null ? "" : prev === 0 ? "—" : `${(conv * 100).toFixed(conv < 0.1 ? 1 : 0)}%`}
                </span>
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
