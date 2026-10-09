"use client";

import Link from "next/link";
import { useState } from "react";
import { Bell, Menu, Pause, Play, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ActionButton } from "@/components/ui/dialog";
import { Kbd } from "@/components/ui/display";
import { setOutreachPausedAction } from "@/app/(app)/shell-actions";
import { NavList, UserBlock, type NavCounts } from "./sidebar";
import { CommandPalette, openCommandPalette } from "./command-palette";
import { ThemeToggle } from "./theme-toggle";
import { Logo } from "@/components/logo";

export function TopBar({
  paused, canPause, notifications, counts, user, workspace,
}: { paused: boolean; canPause: boolean; notifications: number; counts: NavCounts; user: { name: string; email: string; role: string }; workspace: string }) {
  const [drawer, setDrawer] = useState(false);
  return (
    <>
      {paused ? (
        <div className="flex items-center justify-center gap-2 bg-warning px-4 py-1.5 text-[12.5px] font-medium text-white">
          <Pause className="size-3.5" /> All outreach is paused. Nothing can be approved or sent until you resume.
        </div>
      ) : null}
      <header className="sticky top-0 z-20 flex h-11 items-center gap-2 border-b border-border bg-bg/85 px-3 backdrop-blur md:px-4">
        <button className="rounded-md p-1.5 text-fg-2 hover:bg-surface-2 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open menu">
          <Menu className="size-4" />
        </button>
        <button
          onClick={openCommandPalette}
          className="flex h-7 w-full max-w-[420px] items-center gap-2 rounded-md border border-border bg-surface px-2.5 text-[12.5px] text-fg-3 shadow-sm hover:border-border-strong"
        >
          <Search className="size-3.5" />
          <span className="flex-1 truncate text-left">Search prospects, campaigns, conversations…</span>
          <span className="hidden gap-0.5 sm:flex"><Kbd>Ctrl</Kbd><Kbd>K</Kbd></span>
        </button>
        <div className="ml-auto flex items-center gap-1">
          {canPause ? (
            paused ? (
              <ActionButton size="sm" variant="primary" action={() => setOutreachPausedAction(false)}>
                <Play /> Resume outreach
              </ActionButton>
            ) : (
              <ActionButton size="sm" variant="ghost" action={() => setOutreachPausedAction(true)}
                confirm={{ title: "Pause all outreach?", description: "No message can be approved or sent until you resume. Approved messages go back to review.", danger: true }}
                confirmLabel="Pause everything">
                <Pause /> <span className="hidden sm:inline">Pause all outreach</span>
              </ActionButton>
            )
          ) : null}
          <ThemeToggle />
          <Link href="/notifications" className="relative rounded-md p-1.5 text-fg-2 hover:bg-surface-2 hover:text-fg" aria-label={`Notifications (${notifications} unread)`}>
            <Bell className="size-4" />
            {notifications > 0 ? <span className="absolute right-1 top-1 size-2 rounded-full bg-accent ring-2 ring-bg" /> : null}
          </Link>
        </div>
      </header>

      {drawer ? (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDrawer(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[260px] flex-col border-r border-border bg-bg px-2.5 py-3 shadow-lg animate-in">
            <div className="mb-4 flex items-center justify-between px-1.5">
              <div className="flex items-center gap-2">
                <Logo className="size-5" />
                <span className="text-[13px] font-semibold">{workspace}</span>
              </div>
              <Button variant="ghost" size="xs" onClick={() => setDrawer(false)} aria-label="Close menu"><X /></Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <NavList counts={counts} onNavigate={() => setDrawer(false)} />
            </div>
            <UserBlock user={user} />
          </div>
        </div>
      ) : null}
      <CommandPalette />
    </>
  );
}
