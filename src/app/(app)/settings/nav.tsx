"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const ITEMS = [
  { href: "/settings", label: "Workspace" },
  { href: "/settings/team", label: "Team" },
  { href: "/settings/email", label: "Email & sender" },
  { href: "/settings/countries", label: "Country rules" },
  { href: "/settings/taxonomy", label: "Categories & locations" },
  { href: "/settings/senders", label: "Social accounts" },
  { href: "/settings/icp", label: "ICP & scoring" },
  { href: "/settings/goals", label: "Goals" },
  { href: "/settings/sequences", label: "Follow-up sequence" },
  { href: "/settings/dnc", label: "Do-not-contact list" },
  { href: "/settings/audit", label: "Audit log" },
  { href: "/settings/demo", label: "Demo data" },
  { href: "/settings/system", label: "System health" },
];

export function SettingsNav() {
  const path = usePathname();
  return (
    <nav aria-label="Settings" className="flex gap-1 overflow-x-auto md:flex-col">
      {ITEMS.map((i) => (
        <Link key={i.href} href={i.href} aria-current={path === i.href ? "page" : undefined}
          className={cn("whitespace-nowrap rounded-md px-2.5 py-1.5 text-[13px]", path === i.href ? "bg-surface-3 font-medium text-fg" : "text-fg-2 hover:bg-surface-2 hover:text-fg")}>
          {i.label}
        </Link>
      ))}
    </nav>
  );
}
