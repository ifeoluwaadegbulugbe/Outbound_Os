"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ALL_NAV } from "./nav";

/** "g" then a key jumps to a section (g p → Prospects, g q → Outreach queue…). */
export function Shortcuts() {
  const router = useRouter();
  useEffect(() => {
    let pending = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (pending) {
        pending = false;
        clearTimeout(timer);
        const item = ALL_NAV.find((n) => n.key === e.key.toLowerCase());
        if (item) {
          e.preventDefault();
          router.push(item.href);
        }
        return;
      }
      if (e.key === "g") {
        pending = true;
        timer = setTimeout(() => (pending = false), 900);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [router]);
  return null;
}
