"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search, Users, Target, MessageSquare, Plus, Upload, ArrowRight } from "lucide-react";
import { ALL_NAV } from "./nav";
import { cn } from "@/lib/utils";

type Item = { id: string; group: string; label: string; sub?: string; href: string; icon: React.ComponentType<{ className?: string }> };

const OPEN_EVENT = "ob:command-palette";
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

const ACTIONS: Item[] = [
  { id: "a-new-campaign", group: "Actions", label: "Create campaign", href: "/campaigns/new", icon: Plus },
  { id: "a-add-prospect", group: "Actions", label: "Add prospect manually", href: "/discover?tab=capture", icon: Plus },
  { id: "a-import", group: "Actions", label: "Import CSV", href: "/discover?tab=import", icon: Upload },
  { id: "a-queue", group: "Actions", label: "Start sending session", href: "/outreach?tab=send", icon: ArrowRight },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [remote, setRemote] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setRemote([]);
      setActive(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (!open || q.trim().length < 2) {
      setRemote([]);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q.trim())}`, { signal: ctrl.signal });
        if (!res.ok) return;
        const data = (await res.json()) as { results: { type: string; id: string; label: string; sub?: string; href: string }[] };
        setRemote(
          data.results.map((r) => ({
            id: `${r.type}-${r.id}`,
            group: r.type === "prospect" ? "Prospects" : r.type === "campaign" ? "Campaigns" : "Conversations",
            label: r.label,
            sub: r.sub,
            href: r.href,
            icon: r.type === "prospect" ? Users : r.type === "campaign" ? Target : MessageSquare,
          })),
        );
        setActive(0);
      } catch {
        /* aborted */
      } finally {
        setLoading(false);
      }
    }, 140);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q, open]);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const nav: Item[] = ALL_NAV.map((n) => ({ id: `nav-${n.href}`, group: "Go to", label: n.label, href: n.href, icon: n.icon, sub: `g ${n.key}` }));
    const local = [...ACTIONS, ...nav].filter((i) => !needle || i.label.toLowerCase().includes(needle));
    return [...remote, ...local];
  }, [q, remote]);

  const go = (i: Item | undefined) => {
    if (!i) return;
    setOpen(false);
    router.push(i.href);
  };

  if (!open) return null;
  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/40 px-4 pt-[12vh] backdrop-blur-[2px]" onClick={() => setOpen(false)}>
      <div className="w-full max-w-[560px] overflow-hidden rounded-xl border border-border bg-surface shadow-lg animate-in" onClick={(e) => e.stopPropagation()}
        role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-2 border-b border-border px-3.5">
          <Search className="size-4 text-fg-3" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
              if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              if (e.key === "Enter") { e.preventDefault(); go(items[active]); }
              if (e.key === "Escape") setOpen(false);
            }}
            placeholder="Search or jump to…"
            className="h-11 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-3"
            role="combobox"
            aria-expanded
            aria-controls="cmdk-list"
          />
          {loading ? <span className="text-[11px] text-fg-3">Searching…</span> : null}
        </div>
        <ul id="cmdk-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
          {items.length === 0 ? <li className="px-3 py-6 text-center text-[12.5px] text-fg-3">No results for “{q}”</li> : null}
          {items.map((i, idx) => {
            const header = i.group !== lastGroup ? i.group : null;
            lastGroup = i.group;
            return (
              <li key={i.id} role="option" aria-selected={idx === active}>
                {header ? <div className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-fg-3">{header}</div> : null}
                <button
                  onMouseEnter={() => setActive(idx)}
                  onClick={() => go(i)}
                  className={cn("flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-[13px]", idx === active ? "bg-surface-3 text-fg" : "text-fg-2")}
                >
                  <i.icon className="size-4 shrink-0 text-fg-3" />
                  <span className="min-w-0 flex-1 truncate">{i.label}</span>
                  {i.sub ? <span className="truncate text-[11.5px] text-fg-3">{i.sub}</span> : null}
                  {idx === active ? <CornerDownLeft className="size-3.5 text-fg-3" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
