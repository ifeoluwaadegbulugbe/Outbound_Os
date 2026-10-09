import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight } from "lucide-react";
import { cn, withParams, fmtNum } from "@/lib/utils";

export function Table({ className, ...rest }: ComponentProps<"table">) {
  return (
    <div className="w-full overflow-x-auto">
      <table className={cn("w-full border-separate border-spacing-0 text-[12.5px]", className)} {...rest} />
    </div>
  );
}

export function Th({ className, ...rest }: ComponentProps<"th">) {
  return (
    <th
      className={cn(
        "sticky top-0 z-[1] h-8 whitespace-nowrap border-b border-border bg-surface px-3 text-left text-[11.5px] font-medium text-fg-3 first:pl-4 last:pr-4",
        className,
      )}
      {...rest}
    />
  );
}

export function Td({ className, ...rest }: ComponentProps<"td">) {
  return <td className={cn("h-10 border-b border-border px-3 align-middle text-fg first:pl-4 last:pr-4", className)} {...rest} />;
}

export function Tr({ className, ...rest }: ComponentProps<"tr">) {
  return <tr className={cn("group transition-colors hover:bg-surface-2/70 has-[:checked]:bg-accent-subtle/50", className)} {...rest} />;
}

/** Column header that toggles server-side sort via the URL. */
export function SortTh({
  label, field, sort, dir, base, params, className,
}: { label: ReactNode; field: string; sort: string; dir: "asc" | "desc"; base: string; params: Record<string, string | string[] | undefined>; className?: string }) {
  const active = sort === field;
  const nextDir = active && dir === "desc" ? "asc" : "desc";
  return (
    <Th className={className} aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}>
      <Link href={withParams(base, params, { sort: field, dir: nextDir, page: null })} className={cn("inline-flex items-center gap-1 hover:text-fg", active && "text-fg")} scroll={false}>
        {label}
        {active ? dir === "asc" ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" /> : null}
      </Link>
    </Th>
  );
}

export function Pagination({ page, pageSize, total, base, params }: { page: number; pageSize: number; total: number; base: string; params: Record<string, string | string[] | undefined> }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-2 text-[12px] text-fg-3">
      <span className="tabular">
        {fmtNum(from)}–{fmtNum(to)} of {fmtNum(total)}
      </span>
      <div className="flex items-center gap-1">
        <PageLink disabled={page <= 1} href={withParams(base, params, { page: page - 1 })} label="Previous page">
          <ChevronLeft className="size-4" />
        </PageLink>
        <span className="tabular px-1">
          {page} / {pages}
        </span>
        <PageLink disabled={page >= pages} href={withParams(base, params, { page: page + 1 })} label="Next page">
          <ChevronRight className="size-4" />
        </PageLink>
      </div>
    </div>
  );
}

function PageLink({ disabled, href, children, label }: { disabled: boolean; href: string; children: ReactNode; label: string }) {
  if (disabled) return <span className="inline-flex size-7 items-center justify-center rounded-md opacity-40" aria-hidden>{children}</span>;
  return (
    <Link href={href} aria-label={label} scroll={false} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-surface-2 hover:text-fg">
      {children}
    </Link>
  );
}
