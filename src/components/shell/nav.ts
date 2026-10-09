import {
  LayoutDashboard, Target, Users, Search, Layers, Send, Inbox, CalendarClock, BarChart3, FlaskConical, Database, Settings,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** "g" + key navigates here. */
  key: string;
  count?: "review" | "inbox" | "followups";
}

// Email-first order. URLs are unchanged so bookmarks and links keep working.
export const NAV: { section: string | null; items: NavItem[] }[] = [
  {
    section: null,
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard, key: "o" },
      { href: "/prospects", label: "Email Prospects", icon: Users, key: "p" },
      { href: "/discover", label: "Discover Businesses", icon: Search, key: "d" },
      { href: "/campaigns", label: "Email Campaigns", icon: Target, key: "c" },
      { href: "/outreach", label: "Send Queue", icon: Send, key: "q", count: "review" },
      { href: "/inbox", label: "Inbox & Replies", icon: Inbox, key: "i", count: "inbox" },
      { href: "/follow-ups", label: "Follow-ups", icon: CalendarClock, key: "f", count: "followups" },
      { href: "/analytics", label: "Analytics", icon: BarChart3, key: "a" },
      { href: "/integrations", label: "Data Sources", icon: Database, key: "n" },
      { href: "/settings", label: "Settings", icon: Settings, key: "," },
    ],
  },
  {
    section: "More",
    items: [
      { href: "/segments", label: "Segments", icon: Layers, key: "s" },
      { href: "/experiments", label: "Experiments", icon: FlaskConical, key: "e" },
    ],
  },
];

export const ALL_NAV = NAV.flatMap((s) => s.items);
