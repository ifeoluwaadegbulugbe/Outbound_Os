"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut } from "lucide-react";
import { NAV } from "./nav";
import { cn } from "@/lib/utils";
import { Logo } from "@/components/logo";
import { Avatar } from "@/components/ui/display";
import { logoutAction } from "@/app/(auth)/actions";

export interface NavCounts {
  review: number;
  approved: number;
  inbox: number;
  followups: number;
  duplicates: number;
  notifications: number;
}

export function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function NavList({ counts, onNavigate }: { counts: NavCounts; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav className="flex flex-col gap-4" aria-label="Main">
      {NAV.map((s, i) => (
        <div key={i}>
          {s.section ? <div className="mb-1 px-2 text-[11px] font-medium uppercase tracking-wider text-fg-3">{s.section}</div> : null}
          <ul className="flex flex-col gap-px">
            {s.items.map((item) => {
              const active = isActive(pathname, item.href);
              const n = item.count ? counts[item.count] : 0;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "group flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors",
                      active ? "bg-surface-3 font-medium text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg",
                    )}
                  >
                    <item.icon className={cn("size-4 shrink-0", active ? "text-fg" : "text-fg-3 group-hover:text-fg-2")} strokeWidth={1.75} />
                    <span className="flex-1 truncate">{item.label}</span>
                    {n > 0 ? (
                      <span className={cn("tabular rounded px-1.5 text-[11px] font-medium leading-[18px]", item.count === "inbox" ? "bg-accent text-accent-fg" : "bg-surface-3 text-fg-2")}>
                        {n > 999 ? "999+" : n}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

export function Sidebar({ counts, user, workspace }: { counts: NavCounts; user: { name: string; email: string; role: string }; workspace: string }) {
  return (
    <aside className="sticky top-0 hidden h-dvh w-[220px] shrink-0 flex-col border-r border-border bg-bg px-2.5 py-3 lg:flex">
      <div className="mb-4 flex items-center gap-2 px-1.5">
        <Logo className="size-5" />
        <span className="truncate text-[13px] font-semibold">{workspace}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <NavList counts={counts} />
      </div>
      <UserBlock user={user} />
    </aside>
  );
}

export function UserBlock({ user }: { user: { name: string; email: string; role: string } }) {
  return (
    <div className="mt-3 flex items-center gap-2 rounded-md border border-border bg-surface px-2 py-1.5">
      <Avatar name={user.name} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium">{user.name}</div>
        <div className="truncate text-[11px] capitalize text-fg-3">{user.role}</div>
      </div>
      <form action={logoutAction}>
        <button type="submit" className="rounded p-1 text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Sign out" title="Sign out">
          <LogOut className="size-3.5" />
        </button>
      </form>
    </div>
  );
}
