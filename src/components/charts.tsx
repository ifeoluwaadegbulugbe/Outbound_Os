import { cn, fmtNum } from "@/lib/utils";
import { format } from "date-fns";

/**
 * Minimal, dependency-free charts.
 * - DailyBars: one series per chart (small multiples, never dual-axis); thin
 *   bars with 2px gaps, rounded data ends, recessive baseline, hover tooltip
 *   on a full-height hit target.
 * - RateBar: inline horizontal bar for a rate inside a table row; the number
 *   is always printed next to it (identity never by color alone).
 */

export function DailyBars({ title, points, total }: { title: string; points: { day: string; value: number }[]; total?: number }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const sum = total ?? points.reduce((a, p) => a + p.value, 0);
  return (
    <figure className="min-w-0">
      <figcaption className="flex items-baseline justify-between">
        <span className="text-[12px] font-medium text-fg-2">{title}</span>
        <span className="text-[15px] font-semibold tabular text-fg">{fmtNum(sum)}</span>
      </figcaption>
      <div className="relative mt-2 flex h-24 items-end gap-[2px] border-b border-border" role="img" aria-label={`${title}: ${fmtNum(sum)} over ${points.length} days, peak ${fmtNum(max)} per day`}>
        {points.map((p) => (
          <div key={p.day} className="group relative flex h-full min-w-0 flex-1 items-end">
            <div className="w-full rounded-t-[3px] bg-series-1 transition-opacity group-hover:opacity-80" style={{ height: `${(p.value / max) * 100}%`, minHeight: p.value > 0 ? 2 : 0 }} />
            <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded-md border border-border bg-surface px-2 py-1 text-[11.5px] shadow-md group-hover:block">
              <span className="text-fg-3">{format(new Date(p.day), "EEE d MMM")}</span> · <span className="font-semibold tabular text-fg">{fmtNum(p.value)}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[10.5px] text-fg-3 tabular">
        <span>{points[0] ? format(new Date(points[0].day), "d MMM") : ""}</span>
        <span>{points.at(-1) ? format(new Date(points.at(-1)!.day), "d MMM") : ""}</span>
      </div>
    </figure>
  );
}

export function RateBar({ rate, max, lowSample }: { rate: number | null; max: number; lowSample?: boolean }) {
  if (rate == null) return <span className="text-fg-3">—</span>;
  const w = max > 0 ? Math.max(rate > 0 ? 2 : 0, (rate / max) * 100) : 0;
  return (
    <span className="flex items-center gap-2">
      <span className="relative h-2 w-24 shrink-0 overflow-hidden rounded-full bg-surface-3">
        <span className={cn("absolute inset-y-0 left-0 rounded-full", lowSample ? "bg-fg-3/50" : "bg-series-1")} style={{ width: `${w}%` }} />
      </span>
      <span className={cn("tabular text-[12.5px]", lowSample ? "text-fg-3" : "text-fg")}>{(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%</span>
    </span>
  );
}
