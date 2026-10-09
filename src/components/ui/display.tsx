import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-fg-2 border-border",
  accent: "bg-accent-subtle text-accent border-accent/20",
  success: "bg-success-subtle text-success border-success/20",
  warning: "bg-warning-subtle text-warning border-warning/20",
  danger: "bg-danger-subtle text-danger border-danger/20",
  info: "bg-info-subtle text-info border-info/20",
};

export function Badge({ tone = "neutral", children, className, dot }: { tone?: Tone; children: ReactNode; className?: string; dot?: boolean }) {
  return (
    <span className={cn("inline-flex h-5 items-center gap-1 whitespace-nowrap rounded border px-1.5 text-[11.5px] font-medium leading-none", tones[tone], className)}>
      {dot ? <span className="size-1.5 rounded-full bg-current" /> : null}
      {children}
    </span>
  );
}

export function scoreTone(score: number | null | undefined): Tone {
  if (score == null) return "neutral";
  if (score >= 80) return "success";
  if (score >= 60) return "info";
  if (score >= 40) return "warning";
  return "neutral";
}

export function ScoreBadge({ score, className, label }: { score: number | null | undefined; className?: string; label?: string }) {
  const tone = scoreTone(score);
  const color = { success: "text-success", info: "text-info", warning: "text-warning", neutral: "text-fg-3", accent: "", danger: "" }[tone];
  return (
    <span className={cn("inline-flex items-center gap-1.5 tabular text-[12.5px] font-semibold", color, className)} title={label}>
      <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90" aria-hidden>
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
        <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray={`${((score ?? 0) / 100) * 37.7} 37.7`} />
      </svg>
      {score ?? "—"}
    </span>
  );
}

export function Panel({ children, className, title, actions, padded = true, description, id }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; padded?: boolean; description?: ReactNode; id?: string }) {
  return (
    <section id={id} className={cn("rounded-lg border border-border bg-surface shadow-sm", className)}>
      {title || actions ? (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="truncate text-[13px] font-semibold text-fg">{title}</h2>
            {description ? <p className="truncate text-[12px] text-fg-3">{description}</p> : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
        </header>
      ) : null}
      <div className={padded ? "p-4" : undefined}>{children}</div>
    </section>
  );
}

export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="border-b border-border bg-surface/60 px-4 pb-3 pt-4 backdrop-blur md:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[17px] font-semibold tracking-[-0.01em] text-fg">{title}</h1>
          {description ? <p className="mt-0.5 text-[12.5px] text-fg-3">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children ? <div className="mt-3">{children}</div> : null}
    </div>
  );
}

export function EmptyState({ icon, title, description, action, className }: { icon?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-14 text-center", className)}>
      {icon ? <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-border bg-surface-2 text-fg-3 [&_svg]:size-5">{icon}</div> : null}
      <h3 className="text-[14px] font-semibold text-fg">{title}</h3>
      {description ? <p className="mt-1 max-w-sm text-[12.5px] text-fg-3 text-balance">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-border bg-surface-2 px-1 font-mono text-[10.5px] text-fg-3">{children}</kbd>;
}

export function Stat({ label, value, sub, className }: { label: ReactNode; value: ReactNode; sub?: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <div className="truncate text-[11.5px] font-medium uppercase tracking-wide text-fg-3">{label}</div>
      <div className="mt-1 text-[22px] font-semibold tabular tracking-[-0.02em] text-fg">{value}</div>
      {sub ? <div className="mt-0.5 truncate text-[12px] text-fg-3">{sub}</div> : null}
    </div>
  );
}

export function Progress({ value, max = 100, tone = "accent", className }: { value: number; max?: number; tone?: Tone; className?: string }) {
  const pct = Math.max(0, Math.min(100, max ? (value / max) * 100 : 0));
  const bar = { accent: "bg-accent", success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-info", neutral: "bg-fg-3" }[tone];
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-3", className)} role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cn("h-full rounded-full transition-[width] duration-500", bar)} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("skeleton h-4", className)} />;
}

export function Avatar({ name, className }: { name: string; className?: string }) {
  const hue = [...name].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const letters = name.replace(/[^\p{L}\p{N} ]/gu, " ").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  return (
    <span
      className={cn("inline-flex size-6 shrink-0 items-center justify-center rounded-md text-[10.5px] font-semibold", className)}
      style={{ background: `hsl(${hue} 55% 92%)`, color: `hsl(${hue} 45% 32%)` }}
      aria-hidden
    >
      {letters || "?"}
    </span>
  );
}

export function Dl({ items, className }: { items: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-2 text-[12.5px]", className)}>
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-fg-3">{k}</dt>
          <dd className="min-w-0 break-words text-fg">{v ?? <span className="text-fg-3">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}
