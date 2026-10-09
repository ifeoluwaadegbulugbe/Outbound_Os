"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, AlertCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

type ToastKind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  description?: string;
}

let seq = 0;
const listeners = new Set<(t: ToastItem) => void>();

export function toast(title: string, opts: { kind?: ToastKind; description?: string } = {}) {
  const t: ToastItem = { id: ++seq, kind: opts.kind ?? "success", title, description: opts.description };
  listeners.forEach((l) => l(t));
}
toast.error = (title: string, description?: string) => toast(title, { kind: "error", description });
toast.info = (title: string, description?: string) => toast(title, { kind: "info", description });

export function Toaster() {
  const [items, setItems] = useState<ToastItem[]>([]);
  useEffect(() => {
    const add = (t: ToastItem) => {
      setItems((xs) => [...xs.slice(-3), t]);
      setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== t.id)), t.kind === "error" ? 7000 : 3800);
    };
    listeners.add(add);
    return () => {
      listeners.delete(add);
    };
  }, []);
  return (
    <div aria-live="polite" className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(360px,calc(100vw-2rem))] flex-col gap-2">
      {items.map((t) => {
        const Icon = t.kind === "success" ? CheckCircle2 : t.kind === "error" ? AlertCircle : Info;
        return (
          <div key={t.id} role={t.kind === "error" ? "alert" : "status"}
            className="pointer-events-auto flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 shadow-lg animate-in">
            <Icon className={cn("mt-0.5 size-4 shrink-0", t.kind === "success" ? "text-success" : t.kind === "error" ? "text-danger" : "text-info")} />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium text-fg">{t.title}</p>
              {t.description ? <p className="mt-0.5 text-[12px] text-fg-3">{t.description}</p> : null}
            </div>
            <button onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} className="text-fg-3 hover:text-fg" aria-label="Dismiss">
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
