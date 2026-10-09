import { Badge } from "@/components/ui/display";

/** Verification status → badge. "Verified" only ever comes from a mailbox-level check. */
const MAP: Record<string, { label: string; tone: "success" | "info" | "warning" | "danger" | "neutral"; title: string }> = {
  verified: { label: "Verified", tone: "success", title: "Mailbox confirmed by a verification provider" },
  unknown: { label: "Deliverability unknown", tone: "info", title: "Domain accepts mail, but the mailbox couldn't be confirmed" },
  catch_all: { label: "Catch-all", tone: "warning", title: "The domain accepts every address, so this one can't be confirmed" },
  risky: { label: "Risky", tone: "danger", title: "Flagged as risky (spam trap, abuse or do-not-mail)" },
  invalid: { label: "Invalid", tone: "danger", title: "Won't be delivered" },
  unverified: { label: "Not checked", tone: "neutral", title: "Found but not checked yet" },
  none: { label: "No email found", tone: "neutral", title: "No public email address found" },
};

export function EmailStatusBadge({ status, className }: { status: string | null | undefined; className?: string }) {
  const m = MAP[status ?? "none"] ?? MAP.none;
  return <span title={m.title}><Badge tone={m.tone} className={className}>{m.label}</Badge></span>;
}
