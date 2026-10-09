"use client";

import { useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { X } from "lucide-react";
import { Button, type ButtonProps } from "./button";
import { cn } from "@/lib/utils";
import { toast } from "./toast";

/** Native <dialog>: focus trapping, Esc to close and backdrop for free. */
export function Dialog({
  open, onClose, title, description, children, footer, className, wide,
}: { open: boolean; onClose: () => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; className?: string; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100vw-2rem)] rounded-xl border border-border bg-surface p-0 text-fg shadow-lg",
        wide ? "max-w-3xl" : "max-w-lg",
        className,
      )}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-3.5">
            <div>
              <h2 className="text-[14px] font-semibold">{title}</h2>
              {description ? <p className="mt-0.5 text-[12.5px] text-fg-3">{description}</p> : null}
            </div>
            <button onClick={onClose} className="rounded p-1 text-fg-3 hover:bg-surface-2 hover:text-fg" aria-label="Close">
              <X className="size-4" />
            </button>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer ? <footer className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</footer> : null}
        </div>
      ) : null}
    </dialog>
  );
}

export type ActionResult<T = unknown> = { ok: true; message?: string; data?: T } | { ok: false; error: string };

/**
 * Button that runs a server action, with optional confirmation for
 * destructive operations, a pending state and a toast with the real result.
 */
export function ActionButton({
  action, confirm, confirmLabel = "Confirm", children, successMessage, onDone, ...btn
}: {
  action: () => Promise<ActionResult>;
  confirm?: { title: string; description: ReactNode; danger?: boolean };
  confirmLabel?: string;
  successMessage?: string;
  onDone?: (r: ActionResult) => void;
} & Omit<ButtonProps, "onClick">) {
  const [pending, start] = useTransition();
  const [asking, setAsking] = useState(false);
  const run = () =>
    start(async () => {
      try {
        const r = await action();
        if (r.ok) toast(r.message ?? successMessage ?? "Done");
        else toast.error(r.error);
        onDone?.(r);
      } catch (e) {
        toast.error("Something went wrong", e instanceof Error ? e.message : undefined);
      } finally {
        setAsking(false);
      }
    });
  return (
    <>
      <Button {...btn} loading={pending} onClick={() => (confirm ? setAsking(true) : run())}>
        {children}
      </Button>
      {confirm ? (
        <Dialog open={asking} onClose={() => setAsking(false)} title={confirm.title}
          footer={
            <>
              <Button variant="ghost" onClick={() => setAsking(false)}>Cancel</Button>
              <Button variant={confirm.danger ? "danger" : "primary"} loading={pending} onClick={run}>{confirmLabel}</Button>
            </>
          }>
          <div className="text-[13px] text-fg-2">{confirm.description}</div>
        </Dialog>
      ) : null}
    </>
  );
}
